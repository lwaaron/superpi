$wt = "$env:LOCALAPPDATA\Microsoft\WindowsApps\wt.exe"
$node = "C:\Program Files\nodejs\node.exe"
$cli  = "C:\Users\PC\Documents\pi-local\pi-main\packages\coding-agent\dist\bundle\cli.js"
$inner = '"' + $node + '" "' + $cli + '" --resume'
Start-Process -FilePath $wt -ArgumentList @("-d","C:\Users\PC\pi-workspace","cmd","/c",$inner)
Start-Sleep -Seconds 9
Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue | Select-Object Id,MainWindowTitle | Format-List