@echo off
setlocal EnableExtensions
chcp 65001
title superpi one-click start
cd /d "%~dp0.."

rem ======================================================================
rem  superpi : one-click start (tools entry)
rem
rem  Starts a standalone superpi instance (does not touch the desktop profile)
rem  and prints the api url when it is ready.
rem  First run installs dependencies (network needed, a few minutes).
rem  Later runs reuse the install and start in seconds.
rem
rem  Usage:
rem    double-click                    start on the default port (25117)
rem    -Port 25117                     start on a specific port
rem    -Status                         report status only, change nothing
rem    -Stop                           stop the instance this script started
rem    -Reinstall                      force reinstall after a plugin upgrade
rem
rem  WHY THIS FILE IS PURE ASCII:
rem    cmd.exe re-reads the .bat using the *current* console code page. After
rem    "chcp 65001" the byte offsets of any non-ASCII line no longer match the
rem    line boundaries cmd already cached, so multi-byte characters get split
rem    mid-sequence and the following lines run as garbage. ASCII-only keeps
rem    this wrapper correct; the Chinese messages live in the .ps1 instead.
rem ======================================================================

set "HERE=%~dp0"
set "PS1=%HERE%start-standalone.ps1"
set "PWSH="

if not exist "%PS1%" (
  echo [ERROR] start-standalone.ps1 not found.
  echo         expected: %PS1%
  echo.
  pause
  exit /b 1
)

rem Prefer PowerShell 7: the .ps1 is UTF-8, and 7 parses it most reliably.
for /f "delims=" %%I in ('where pwsh.exe 2^>nul') do if not defined PWSH set "PWSH=%%I"
if not defined PWSH if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"

if defined PWSH (
  "%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
) else (
  echo  [note] PowerShell 7 not found, falling back to Windows PowerShell 5.1.
  echo         The script is saved as UTF-8 with BOM, so 5.1 reads it correctly.
  echo.
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
)

set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo  [ok] See the output above for the api url, log path and how to stop.
) else (
  echo  [failed] exit code %RC% - see the output above.
)
echo.
pause
exit /b %RC%
