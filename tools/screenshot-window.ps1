
param([string]$Title='[DSH]', [int]$ProcessId=0, [string]$Out='C:\Users\PC\AppData\Local\Temp\shot.png')
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Shot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[Win32Shot]::SetProcessDPIAware() | Out-Null
$target = $null
if ($ProcessId -ne 0) {
  $target = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
} else {
  $target = Get-Process | Where-Object { $_.MainWindowTitle -like "*$Title*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}
if ($null -eq $target) { Write-Error "no window matching '$Title'"; exit 1 }
Write-Output ("pid=" + $target.Id + " title=" + $target.MainWindowTitle)
$h = $target.MainWindowHandle
[Win32Shot]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
$rect = New-Object Win32Shot+RECT
[Win32Shot]::GetWindowRect($h, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$hh = $rect.Bottom - $rect.Top
Write-Output ("rect=" + $rect.Left + "," + $rect.Top + " size=" + $w + "x" + $hh)
$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [Win32Shot]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("printwindow=" + $ok + " out=" + $Out)
