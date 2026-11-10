@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo subgen 正在启动，控制台： http://127.0.0.1:25500/alexwrt/admin
start "" "http://127.0.0.1:25500/alexwrt/admin"
subgen.exe -c config.yaml
echo.
echo 服务已退出。按任意键关闭窗口。
pause >nul
