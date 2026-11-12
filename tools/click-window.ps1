param([int]$ProcessId,[int]$X,[int]$Y)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CW {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
[CW]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Id $ProcessId
$h = $p.MainWindowHandle
[CW]::ShowWindow($h, 9) | Out-Null
[CW]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
$rect = New-Object CW+RECT
[CW]::GetWindowRect($h, [ref]$rect) | Out-Null
$ax = $rect.Left + $X
$ay = $rect.Top + $Y
[CW]::SetCursorPos($ax, $ay) | Out-Null
Start-Sleep -Milliseconds 150
$pt = New-Object CW+POINT
[CW]::GetCursorPos([ref]$pt) | Out-Null
[CW]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 80
[CW]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 200
Write-Output ("window=" + $rect.Left + "," + $rect.Top + " target=" + $ax + "," + $ay + " cursor=" + $pt.X + "," + $pt.Y)
