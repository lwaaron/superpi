param([int]$ProcessId)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IME {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr LoadKeyboardLayout(string pwszKLID, uint Flags);
  [DllImport("user32.dll")] public static extern IntPtr ActivateKeyboardLayout(IntPtr hkl, uint Flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("imm32.dll")] public static extern IntPtr ImmAssociateContext(IntPtr hWnd, IntPtr hIMC);
  [DllImport("imm32.dll")] public static extern IntPtr ImmGetContext(IntPtr hWnd);
}
"@
[IME]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Id $ProcessId
$h = $p.MainWindowHandle
[IME]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
$hkl = [IME]::LoadKeyboardLayout("00000409", 1)
Write-Output ("hkl=" + $hkl)
[IME]::PostMessage($h, 0x0050, [IntPtr]0, $hkl) | Out-Null
Start-Sleep -Milliseconds 500
[IME]::ActivateKeyboardLayout($hkl, 0) | Out-Null
Start-Sleep -Milliseconds 300
$old = [IME]::ImmAssociateContext($h, [IntPtr]::Zero)
Write-Output ("ime_context_removed=" + $old)
