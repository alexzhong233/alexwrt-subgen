#!/bin/sh
# macOS 双击运行（首次可能要右键 → 打开，或执行 xattr -d com.apple.quarantine ./subgen）
cd "$(dirname "$0")" || exit 1
chmod +x ./subgen 2>/dev/null
echo "subgen 正在启动，控制台： http://127.0.0.1:25500/alexwrt/admin"
open "http://127.0.0.1:25500/alexwrt/admin" 2>/dev/null &
exec ./subgen -c config.yaml
