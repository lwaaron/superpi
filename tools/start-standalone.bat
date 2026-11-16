@echo off
setlocal EnableExtensions
chcp 65001 >nul
title 一键启动 dsh-pi（独立实例）
cd /d "%~dp0.."

rem ======================================================================
rem  dsh-pi / 一键启动
rem
rem  双击即起一个独立的 dsh-pi 实例（不碰桌面 profile），起完会打印访问地址。
rem  首次运行要装依赖（需联网，几分钟）；之后直接复用，秒起。
rem
rem  用法：
rem    双击本文件                        用默认端口 25117 启动
rem    start-standalone.bat -Port 25117   指定端口
rem    start-standalone.bat -Status       只看状态，不启动
rem    start-standalone.bat -Stop         停掉已启动的实例
rem    start-standalone.bat -Reinstall    插件升级后强制重装
rem ======================================================================

set "HERE=%~dp0"
set "PS1=%HERE%start-standalone.ps1"
set "PWSH="

if not exist "%PS1%" (
  echo [错误] 找不到 start-standalone.ps1
  echo        期望位置：%PS1%
  echo.
  pause
  exit /b 1
)

rem ---- 1. 优先用 PowerShell 7（pwsh）：脚本是 UTF-8 写的，7 解析最稳 --------
for /f "delims=" %%I in ('where pwsh.exe 2^>nul') do if not defined PWSH set "PWSH=%%I"
if not defined PWSH if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"

if defined PWSH (
  "%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
) else (
  echo  [提示] 没找到 PowerShell 7，改用系统自带的 Windows PowerShell 5.1。
  echo         脚本已按 UTF-8 BOM 保存，5.1 也能正确读中文。
  echo.
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
)

set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo  [完成] 实例已就绪，浏览器打开上面的地址即可。
) else (
  echo  [失败] 退出码 %RC%，请看上面的输出。
)
echo.
pause
exit /b %RC%
