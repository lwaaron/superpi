param([int]$ProcessId)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class FW {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
}
"@
[FW]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Id $ProcessId
$h = $p.MainWindowHandle
$fg = [FW]::GetForegroundWindow()
$fgPid = [IntPtr]::Zero
$fgThread = [FW]::GetWindowThreadProcessId($fg, $fgPid)
$me = [FW]::GetCurrentThreadId()
[FW]::AttachThreadInput($me, $fgThread, $true) | Out-Null
[FW]::ShowWindow($h, 9) | Out-Null
[FW]::BringWindowToTop($h) | Out-Null
[FW]::SetForegroundWindow($h) | Out-Null
[FW]::AttachThreadInput($me, $fgThread, $false) | Out-Null
Start-Sleep -Milliseconds 600
$now = [FW]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[FW]::GetWindowText($now, $sb, 512) | Out-Null
Write-Output ("target=" + $h + " foreground_now=" + $now + " title=" + $sb.ToString())
