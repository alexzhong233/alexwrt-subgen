subgen —— 订阅转换 + 分级生成（macOS Apple Silicon 版）
=====================================================

1) 首次运行会被 Gatekeeper 拦（二进制没签名），两种解法：
   · 右键 start.command → 打开 → 仍要打开
   · 或终端执行：xattr -d com.apple.quarantine ./subgen ./start.command

2) 双击 start.command
   浏览器会自动打开 http://127.0.0.1:25500/alexwrt/admin

3) 控制台里填订阅 / 静态连接 / 规则 / 分级，右侧实时预览，满意了点「保存并生效」
   订阅地址：http://127.0.0.1:25500/alexwrt/sub

不想常驻怎么办（推荐）
--------------------
· sync-once.command  —— 只生成一份 mihomo-config.yaml，跑完就退出
· schedule.command   —— 装 launchd 任务，每天 04:30 自动同步一次
                       卸载：launchctl unload ~/Library/LaunchAgents/com.alex.subgen.sync.plist
· 控制台里右上角「关闭后端」也能直接把服务停掉

退出：终端里 Ctrl+C。
