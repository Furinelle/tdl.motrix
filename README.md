# tdl.motrix

在 Motrix 里粘贴 Telegram 消息链接，经本机桥用已登录的 tdl `--serve`，再由 Motrix 下载。插件 ID 与仓库名均为 `tdl.motrix`。

桥会同时监听 aria2 的任务启动事件并轮询活动、等待及刚结束的任务。即使 `t.me` 原始任务在几毫秒内因 DNS 失败或误下成 HTML，桥仍会清理该任务，解析真实媒体地址并重新交给 Motrix 下载。

设计：`docs/superpowers/specs/2026-08-17-tdl-motrix-design.md`

## 本机要求

- 已安装并登录 [tdl](https://github.com/iyear/tdl)：`tdl login`
- Motrix 2.0 桌面端
- Node 22（Homebrew `node@22`）

## 安装

```bash
git clone https://github.com/Furinelle/tdl.motrix.git
cd tdl.motrix
pnpm --dir plugin install
pnpm --dir plugin run pack
chmod +x scripts/install-macos.sh
./scripts/install-macos.sh
```

然后打开 Motrix → 插件 → **添加插件**，选：

`plugin/dist/tdl.motrix-0.1.7.moext`

（也可从 GitHub Releases 下载已打包的 `.moext`。）

通过 tdl 解析的文件默认保存到 `~/Downloads/Motrix/tg`，并保留 Telegram
媒体返回的原始文件名和扩展名。

授权 `http` 后启用。

检查桥：

```bash
curl -s http://127.0.0.1:16808/status
```

应看到 `"tdl": true, "loggedIn": true`。

## 使用

在 **Motrix 窗口**里新建任务（或 Chrome「使用 Motrix 下载」），贴官方客户端复制的消息链接，例如 `https://t.me/channel/123`。

接管成功后，真实媒体任务会出现在下载列表，文件保存在 Motrix 默认下载目录下的 `tg/` 子目录，例如：

```text
~/Downloads/Motrix/tg/
```

原始 `t.me` 任务若在桥接管前已经瞬时失败，通知页可能仍保留一条“网络连接失败”历史通知；只要下载列表里已经出现真实媒体任务，就表示接管成功。该通知不是残余下载文件，可在通知页清空。

`motrix add https://t.me/...` 走 CLI 桥，**不会**跑插件。命令行请用：

```bash
node scripts/tdl-add.mjs 'https://t.me/channel/123'
```

## 排查

检查桥和 tdl 登录状态：

```bash
curl -s http://127.0.0.1:16808/status
```

应看到 `"tdl": true, "loggedIn": true`。如果桥没有响应，可重启并查看日志：

```bash
launchctl kickstart -k "gui/$(id -u)/app.tdl.motrix.bridge"
tail -f ~/Library/Logs/tdl-bridge.log
```

## 取消与清理

不再需要某个下载时，先用 `motrix list` 找到对应任务 ID，再只删除该任务及其部分文件：

```bash
motrix list
motrix remove --delete-files '<taskId>'
```

这会清理选定任务的未完成文件和 aria2 控制文件，不影响其他下载。通知页中的历史消息需单独清空。

## 卸载桥

```bash
launchctl bootout "gui/$(id -u)/app.tdl.motrix.bridge"
rm -f ~/Library/LaunchAgents/app.tdl.motrix.bridge.plist
```
