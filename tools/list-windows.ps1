$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
Add-Type -TypeDefinition $src
$rows = New-Object System.Collections.ArrayList
$cb = [Win+EnumWindowsProc]{
  param($h, $p)
  if ([Win]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][Win]::GetWindowText($h, $sb, 512)
    $t = $sb.ToString()
    if ($t.Length -gt 0) {
      $wpid = 0
      [void][Win]::GetWindowThreadProcessId($h, [ref]$wpid)
      $proc = (Get-Process -Id $wpid -ErrorAction SilentlyContinue)
      [void]$rows.Add([pscustomobject]@{ Handle = ('0x{0:X}' -f $h.ToInt64()); Pid = $wpid; Proc = $(if ($proc) { $proc.ProcessName } else { '?' }); Title = $t })
    }
  }
  return $true
}
[void][Win]::EnumWindows($cb, [IntPtr]::Zero)
$rows | Format-Table -AutoSize | Out-String -Width 220
