param([int]$ProcessId,[int]$X,[int]$Y,[string]$Text,[switch]$Enter,[int]$WaitSeconds=0)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class PA {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[PA]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Id $ProcessId
$h = $p.MainWindowHandle
[PA]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
$rect = New-Object PA+RECT
[PA]::GetWindowRect($h, [ref]$rect) | Out-Null
[PA]::SetCursorPos(($rect.Left + $X), ($rect.Top + $Y)) | Out-Null
Start-Sleep -Milliseconds 150
[PA]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[PA]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 400
[System.Windows.Forms.Clipboard]::SetText($Text)
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 600
if ($Enter) { [System.Windows.Forms.SendKeys]::SendWait("{ENTER}") }
if ($WaitSeconds -gt 0) { Start-Sleep -Seconds $WaitSeconds }
Write-Output ("pasted len=" + $Text.Length + " at " + ($rect.Left+$X) + "," + ($rect.Top+$Y))
