@echo off
setlocal EnableExtensions
chcp 65001
cd /d "%~dp0"

rem ======================================================================
rem  superpi : one-click launch (repo root entry)
rem
rem  Starts BOTH front ends at once, in parallel, neither blocking the other:
rem
rem    1) pi TUI  - a real console window running the coding session
rem                 (this is the interactive coding agent you type into)
rem    2) DSH web - a standalone instance of the superpi panel on port 25117
rem                 (browser / sidebar UI, runs in the background)
rem
rem  They are two parallel front ends of the SAME pi and the SAME agent loop.
rem  Neither replaces the other: the TUI is for writing code, the web panel is
rem  for the GUI.
rem
rem  All real logic lives in tools\launch-both.ps1 -- this file only forwards.
rem
rem  Usage:
rem    double-click                    start both (TUI window + web on 25117)
rem    -Resume pick                    pick a past session to resume
rem    -Resume new                     start a fresh session
rem    -WorkDir D:\path\to\project     the folder the agent works in
rem    -NoTui / -NoWeb                 start only one of the two
rem    -Port 25117                     web port
rem    -Status                         report both, change nothing
rem    -Stop                           stop both
rem
rem  WHY THIS FILE IS PURE ASCII:
rem    cmd.exe re-reads the .bat using the *current* console code page. After
rem    "chcp 65001" the byte offsets of any non-ASCII line no longer match the
rem    line boundaries cmd already cached, so multi-byte characters get split
rem    mid-sequence and the following lines run as garbage. ASCII-only keeps
rem    this wrapper correct; all Chinese text lives in the .ps1 instead.
rem ======================================================================

set "TARGET=%~dp0tools\launch-both.ps1"
set "PWSH="

if not exist "%TARGET%" (
  echo [ERROR] tools\launch-both.ps1 not found.
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
  echo  [ok] Done - see the summary above for each front end.
) else (
  echo  [failed] exit code %RC% - see the output above.
)
echo.
pause
exit /b %RC%
