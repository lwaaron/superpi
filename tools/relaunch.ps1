$out = "C:\Users\PC\Documents\pi-local\dsh-pi\out\final-check.png"
Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*coding-agent*cli.js*' -and $_.CommandLine -notlike '*--mode rpc*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 900
Start-Process -FilePath "C:\Users\PC\Documents\pi-local\pi-main\一键启动.bat"
Start-Sleep -Seconds 11
$p = Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
"pid=" + $p.Id + " title=" + $p.MainWindowTitle
pwsh -NoProfile -File "C:\Users\PC\Documents\pi-local\dsh-pi\tools\screenshot-window.ps1" -ProcessId $p.Id -Out $out
