@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 只生成一次配置，不常驻。给本机 Clash/Mihomo 当订阅文件用，也可以挂计划任务定时跑。
subgen.exe -c config.yaml -gen mihomo-config.yaml
if errorlevel 1 (
  echo 生成失败，看看上面输出的错误。
) else (
  echo 已生成：%~dp0mihomo-config.yaml
)
