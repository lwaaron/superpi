param(
  [int]$ProcessId,
  [string]$Keys = "{ENTER}",
  [string]$Out = "",
  [int]$WaitSeconds = 3
)
$src = 'using System; using System.Runtime.InteropServices; public class WP { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); }'
Add-Type -TypeDefinition $src
$p = Get-Process -Id $ProcessId
[WP]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[WP]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 500
$ws = New-Object -ComObject WScript.Shell
$ws.SendKeys($Keys)
Start-Sleep -Seconds $WaitSeconds
if ($Out) { pwsh -NoProfile -File "$PSScriptRoot\screenshot-window.ps1" -ProcessId $ProcessId -Out $Out }
