@echo off
setlocal EnableExtensions
chcp 65001 >nul
title 重启 DSH（让 dsh-pi 生效）

rem ======================================================================
rem  重启 DSH 并核对 dsh-pi 是否换成了磁盘上那份代码。
rem
rem  为什么要有这个 bat：插件在 import 时把代码快照进内存，改完必须重启 DSH
rem  才生效；而重启会杀掉当前会话所在的宿主进程，所以不能在 DSH 对话里跑。
rem
rem  用法：
rem    双击本文件                      重启 + 核对版本
rem    restart-dsh.bat -SkipRestart    只核对，不重启
rem    restart-dsh.bat -Port 4070      指定端口
rem ======================================================================

set "HERE=%~dp0"
set "PS1=%HERE%restart-dsh.ps1"
set "PWSH="

if not exist "%PS1%" (
  echo [错误] 找不到 restart-dsh.ps1
  echo        期望位置：%PS1%
  echo.
  pause
  exit /b 1
)

rem ---- 1. 优先用 PowerShell 7（pwsh）：重启脚本是 UTF-8 写的，7 解析最稳 ----
for /f "delims=" %%I in ('where pwsh.exe 2^>nul') do if not defined PWSH set "PWSH=%%I"
if not defined PWSH if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"

if defined PWSH (
  echo  使用 PowerShell 7：%PWSH%
  echo.
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
  echo  [完成] 检查通过。可以关闭这个窗口了。
) else (
  echo  [失败] 退出码 %RC%，请看上面的输出。
  echo         退出码 1 = 没找到 DSH 或重启后没等到接口；2 = 版本仍不一致。
)
echo.
pause
exit /b %RC%
