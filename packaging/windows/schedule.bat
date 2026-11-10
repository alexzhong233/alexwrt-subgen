@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 安装一个每天 04:30 执行一次的同步任务（不需要管理员权限）
schtasks /Query /TN subgen-sync >nul 2>&1
if %errorlevel%==0 (
  schtasks /Delete /TN subgen-sync /F >nul
)
schtasks /Create /TN subgen-sync /TR "\"%~dp0sync-once.bat\"" /SC DAILY /ST 04:30 /F
if errorlevel 1 (
  echo 安装失败。也可以手动在“任务计划程序”里建：程序选 sync-once.bat，每天跑一次。
) else (
  echo 已安装计划任务 subgen-sync，每天 04:30 生成一次 mihomo-config.yaml
  echo 删除：schtasks /Delete /TN subgen-sync /F
)
pause
