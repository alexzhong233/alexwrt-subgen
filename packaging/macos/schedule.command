#!/bin/sh
# 用 launchd 装一个每天 04:30 的同步任务
cd "$(dirname "$0")" || exit 1
DIR="$(pwd)"
PLIST="$HOME/Library/LaunchAgents/com.alex.subgen.sync.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.alex.subgen.sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>$DIR/subgen</string>
    <string>-c</string><string>$DIR/config.yaml</string>
    <string>-gen</string><string>$DIR/mihomo-config.yaml</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$DIR/sync.log</string>
  <key>StandardErrorPath</key><string>$DIR/sync.log</string>
</dict>
</plist>
EOF
launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST" && echo "已安装 launchd 任务 com.alex.subgen.sync（每天 04:30）"
echo "卸载：launchctl unload $PLIST && rm $PLIST"
