# tdl × Motrix 集成设计

日期：2026-08-17  
状态：已自审，第一版已实现  
范围：第一版（方案 1）

在 Motrix 里粘贴 Telegram 消息链接（或经 Chrome 扩展丢进来），用本机已登录的 tdl 做鉴权与媒体暴露，再用 Motrix 引擎下载。进度、暂停、保存目录走 Motrix。

## 目标与非目标

**目标**

- 用户在 Motrix 新建任务或 Chrome「使用 Motrix 下载」中提交 `t.me` / `telegram.me` 消息链接。
- 任务出现在 Motrix 列表，按普通 HTTP 任务显示进度。
- 文件保存到 Motrix 当前默认目录（本机为 `~/Downloads`）。
- 复用已有 `~/.tdl` 会话，不在 Motrix 里登录 Telegram。

**非目标（第一版不做）**

- 整段聊天 JSON 导出、上传、转发。
- Motrix 内登录 / 换号向导、收验证码。
- 多命名空间切换 UI（设置里可写死/预留 `default`）。
- 无痕窗口专项支持。
- 修改官方 Motrix 或官方 Chrome 扩展源码。

## 架构

两块进程，插件不 exec。

```
Motrix 新建任务 / Chrome 丢链接
        ↓
  插件 furina.tdl 认出消息链接
        ↓
  tdl-bridge (127.0.0.1:16808)
        ↓
  tdl dl --serve  (复用 ~/.tdl)
        ↓
  本地 HTTP 直链
        ↓
  Motrix aria2 正常下载
```

### tdl-bridge（本机小服务）

- 只监听 `127.0.0.1:16808`（避开 Motrix RPC `16800` 和 tdl serve 默认 `8080`）。
- 用 launchd 开机启动。
- 可执行本机 `tdl` 与 `motrix` CLI。
- 会话：默认命名空间 `default`，存储即用户现有 `~/.tdl`。
- 不把 session、验证码、手机号写入自己的配置或日志。

### Motrix 插件 `furina.tdl`

- 类别：`site-resolver`。
- Hook：`beforeCreate`。
- 权限：`http`；`hostPermissions` 仅本机桥和 Telegram 链接识别所需（请求只打 `127.0.0.1:16808`）。
- 不申请 shell / 任意文件系统。
- 打包为 `.moext`，在 Motrix 插件页「添加插件」安装。

Chrome 扩展不改：链接进入 Motrix 后由插件处理。

## 登录

- 不在 Motrix 或插件里做 Telegram 登录。
- 已登录：直接 resolve。本机当前已有可用会话。
- 未登录或会话失效：任务失败，提示到终端执行 `tdl login`，完成后再重试。
- 换号 / 多账号：继续用 tdl 的 `-n`；第一版固定 `default`。

`GET /status` 供插件在改写 URL 前检查登录态。

## 数据流

插件只处理消息链接，例如：

- `https://t.me/<channel>/<msgId>`
- `https://t.me/c/<chatId>/<msgId>`
- 带 topic/comment 的官方「复制链接」变体
- `https://telegram.me/...` 同等形式

不是这类链接则原样返回，插件不改写。

认出之后：

1. `GET http://127.0.0.1:16808/status`  
   未登录 → 失败，文案：`tdl 未登录，请在终端执行 tdl login 后重试`
2. `POST http://127.0.0.1:16808/resolve`

```json
{
  "url": "https://t.me/channel/123",
  "saveDir": "/Users/furina/Downloads",
  "group": true
}
```

3. 小服务执行：

```bash
tdl dl --serve --port <临时端口> -u <url> --group
```

解析 serve 文件列表后返回：

```json
{
  "ok": true,
  "files": [
    { "url": "http://127.0.0.1:5xxxx/xxx.mp4", "filename": "xxx.mp4" }
  ]
}
```

4. 插件 `ctx.update({ uris, filename })` 把当前任务改成第一个文件。  
   相册其余文件由小服务调用 `motrix add --save-dir <saveDir>` 另建任务。

同一条链接在 serve 仍存活时重复提交，复用已有进程，不新开 tdl。

## 超时

| 步骤 | 上限 | 超时后 |
|------|------|--------|
| `GET /status` | 2 秒 | 视为小服务未运行 |
| `POST /resolve`（等到文件列表） | 45 秒 | 杀掉该次 serve，返回解析超时 |
| serve 进程存活 | 下载开始后 6 小时，或相关 HTTP 传输结束 | 退出 tdl，释放端口 |

## 失败处理

插件失败时 **不改写 URL**，避免 Motrix 去下载 `t.me` 网页得到 HTML。

| 原因 | 用户可见文案 |
|------|----------------|
| 小服务无响应 | `tdl-bridge 未运行，请先启动本机服务` |
| 本机没有 `tdl` | `未找到 tdl，请先 brew install tdl` |
| 未登录 / 会话失效 | `tdl 未登录，请在终端执行 tdl login` |
| 链接没有媒体 | `这条 Telegram 消息没有可下载的文件` |
| Telegram 限流 | `Telegram 限流，请稍后重试` |
| 解析超时 | `tdl 解析超时` |

小服务只绑回环地址。日志只记链接、端口、文件数、错误码，不记 session 内容。

## 测试

手工验收，不为 tdl / Telegram 协议写单元测试。

1. 服务开着且已登录：Motrix 贴一条有文件的消息链接 → HTTP 任务，文件进 `~/Downloads`，文件名正确。
2. Chrome 右键「使用 Motrix 下载」同一链接 → 同上。
3. 相册链接：Motrix 出现多条任务。
4. 小服务未启动：失败提示未运行，不会变成 HTML 文件。
5. 会话失效后再试：提示未登录；`tdl login` 后重试成功。
6. 纯文本消息：提示没有可下载文件。
7. 普通 `https://example.com/file.zip`：插件不插手。

可用 `curl 127.0.0.1:16808/status` 确认已登录。小服务日志应能看到 URL、端口、文件数。

## 组件清单（实现时）

| 组件 | 形式 |
|------|------|
| `tdl-bridge` | 本机 HTTP 服务 + launchd plist |
| `furina.tdl` | Motrix 插件（`pnpm create motrix-plugin`） |
| 安装说明 | README：装插件、加载 launchd、确认 `tdl login` |

## 已否决

- 仅用 tdl 本机下载、Motrix 只当目录（看不到进度）。
- 只做 tdl 扩展、不在 Motrix 里贴链接（不符合方向 A）。
- 在插件或 Motrix UI 中收集 Telegram 验证码。
