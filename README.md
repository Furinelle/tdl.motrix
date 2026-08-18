# tdl.motrix

在 Motrix 里粘贴 Telegram 消息链接，经本机桥用已登录的 tdl `--serve`，再由 Motrix 下载。插件 ID 与仓库名均为 `tdl.motrix`。

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

`plugin/dist/tdl.motrix-0.1.4.moext`

（也可从 GitHub Releases 下载已打包的 `.moext`。）

授权 `http` 后启用。

检查桥：

```bash
curl -s http://127.0.0.1:16808/status
```

应看到 `"tdl": true, "loggedIn": true`。

## 使用

在 **Motrix 窗口**里新建任务（或 Chrome「使用 Motrix 下载」），贴官方客户端复制的消息链接，例如 `https://t.me/channel/123`。

`motrix add https://t.me/...` 走 CLI 桥，**不会**跑插件。命令行请用：

```bash
node scripts/tdl-add.mjs 'https://t.me/channel/123'
```

## 卸载桥

```bash
launchctl bootout "gui/$(id -u)/app.tdl.motrix.bridge"
rm -f ~/Library/LaunchAgents/app.tdl.motrix.bridge.plist
```
