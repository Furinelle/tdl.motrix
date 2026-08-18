#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="app.furina.tdl-bridge"
PLIST_SRC="$ROOT/bridge/launchd/${LABEL}.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${LABEL}.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$PLIST_SRC" "$PLIST_DST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
sleep 0.4
curl -sf "http://127.0.0.1:16808/status"
echo
echo "tdl-bridge installed and running"
echo "Install the plugin in Motrix: 插件 → 添加插件 → $ROOT/plugin/dist/furina.tdl-0.1.3.moext"
