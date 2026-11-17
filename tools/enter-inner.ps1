
$sig = @"
using System;
using System.Runtime.InteropServices;
public class W2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
"@
Add-Type -TypeDefinition $sig
$p = Get-Process -Id 55416
[W2]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[W2]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 500
$ws = New-Object -ComObject WScript.Shell
$ws.SendKeys("{ENTER}")
Start-Sleep -Seconds 3
pwsh -NoProfile -File C:\Users\PC\Documents\pi-local\superpi\tools\screenshot-window.ps1 -ProcessId 55416 -Out C:\Users\PC\Documents\pi-local\superpi\out\bat-inner.png
