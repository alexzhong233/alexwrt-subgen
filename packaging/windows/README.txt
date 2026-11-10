subgen —— 订阅转换 + 分级生成（Windows 版）
=========================================

1) 双击 start.bat
   浏览器会自动打开 http://127.0.0.1:25500/alexwrt/admin

2) 控制台里填：
   · 订阅：机场的 clash 订阅链接（可多条，失败的那条会自动跳过）
   · 静态连接：机场订阅里没有的单独节点（socks5 / ss / trojan / vless ...）
   · 规则：内联（自带 9k 条）或远程规则集
   · 分级：zanz → 时间订阅池 → 按量订阅池 → DIRECT 这种降级链
   右侧会实时显示转换结果（节点数/组数/规则数/每个组的成员）

3) 点「保存并生效」，配置写入 config.yaml（旧文件备份成 config.yaml.bak）
   订阅地址：http://127.0.0.1:25500/alexwrt/sub
   可以直接喂给 Clash / Mihomo / Nikki 等客户端。

想给局域网其他设备用：把 config.yaml 里 listen 改成 0.0.0.0:25500，
然后把 token 换成你自己的，并用防火墙限制来源。

不想常驻怎么办（推荐）
------------------------
· 同步一次.bat   —— 只生成一份 mihomo-config.yaml，跑完就退出
· schedule.bat   —— 装个每天 04:30 自动跑“同步一次”的计划任务
                   删掉：schtasks /Delete /TN subgen-sync /F
· 控制台里右上角「关闭后端」也能直接把服务停掉

退出：关掉黑窗口即可（或用任务管理器结束 subgen.exe）。
