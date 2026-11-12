param([int]$ProcessId,[int]$X,[int]$Y,[string]$Text,[int]$WaitSeconds=0,[switch]$Enter)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class TI {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[TI]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Id $ProcessId
$h = $p.MainWindowHandle
[TI]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
$rect = New-Object TI+RECT
[TI]::GetWindowRect($h, [ref]$rect) | Out-Null
$ax = $rect.Left + $X
$ay = $rect.Top + $Y
[TI]::SetCursorPos($ax, $ay) | Out-Null
Start-Sleep -Milliseconds 150
[TI]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[TI]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 350
$sh = New-Object -ComObject WScript.Shell
Start-Sleep -Milliseconds 200
$sh.SendKeys($Text)
if ($Enter) { Start-Sleep -Milliseconds 200; $sh.SendKeys("{ENTER}") }
if ($WaitSeconds -gt 0) { Start-Sleep -Seconds $WaitSeconds }
Write-Output ("typed at " + $ax + "," + $ay + " text=" + $Text)
