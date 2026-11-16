@echo off
setlocal EnableExtensions
chcp 65001
cd /d "%~dp0"

rem ======================================================================
rem  dsh-pi : one-click launcher (repo root entry)
rem
rem  This file is ONLY a forwarder. All real logic lives in
rem  tools\start-standalone.ps1 -- one copy, no duplicated logic to drift.
rem
rem  Usage:
rem    double-click                    start on the default port (25117)
rem    -Port 25117                     start on a specific port
rem    -Status                         report status only, change nothing
rem    -Stop                           stop the instance this script started
rem    -Reinstall                      force reinstall after a plugin upgrade
rem
rem  WHY THIS FILE IS PURE ASCII:
rem    cmd.exe re-reads the .bat file using the *current* console code page.
rem    After "chcp 65001" the byte offsets of any non-ASCII line no longer match
rem    the line boundaries cmd already cached, so multi-byte characters get
rem    split mid-sequence and the following lines are executed as garbage.
rem    Keeping this file ASCII-only makes the forwarder immune to that. The
rem    Chinese title/echo live in tools\start-standalone.ps1 (a PowerShell
rem    file, which cmd never parses) so the user still sees Chinese.
rem ======================================================================

set "TARGET=%~dp0tools\start-standalone.ps1"
set "PWSH="

if not exist "%TARGET%" (
  echo [ERROR] tools\start-standalone.ps1 not found.
  echo         expected: %TARGET%
  echo.
  echo         Check that the tools directory is complete.
  echo.
  pause
  exit /b 1
)

rem Prefer PowerShell 7: the .ps1 is UTF-8, and 7 parses it most reliably.
for /f "delims=" %%I in ('where pwsh.exe 2^>nul') do if not defined PWSH set "PWSH=%%I"
if not defined PWSH if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"

if defined PWSH (
  "%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%TARGET%" %*
) else (
  echo  [note] PowerShell 7 not found, falling back to Windows PowerShell 5.1.
  echo         The script is saved as UTF-8 with BOM, so 5.1 reads it correctly.
  echo.
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%TARGET%" %*
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
