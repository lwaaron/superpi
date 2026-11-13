# Function-level assertions for tools\restart-dsh.ps1 (loaded in library mode).
# ASCII only on purpose: this file is also run under Windows PowerShell 5.1, and a
# UTF-8 file without BOM would be read as ANSI there.
# Invoked by test/restart-lib.mjs. Prints "ok <name>" / "FAIL <name>" lines.
param([int]$HtmlPort = 0)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'tools\restart-dsh.ps1'
if (-not (Test-Path -LiteralPath $script)) { Write-Output "FAIL script missing: $script"; exit 1 }

$env:DSH_PI_RESTART_LIB = '1'
. $script

$script:failures = 0
function check([bool]$ok, [string]$name) {
  if ($ok) { Write-Output "ok   $name"; return }
  $script:failures++
  Write-Output "FAIL $name"
}

# --- Get-LaunchSpec: the launch command must survive byte-for-byte -------------
$quotedInfo = [pscustomobject]@{
  ProcessId      = 1234
  ExecutablePath = 'C:\Program Files\App\App.exe'
  CommandLine    = '"C:\Program Files\App\App.exe" --expose-internals "C:\a b\index.js" --port 5599'
}
$spec = Get-LaunchSpec $quotedInfo
check ($spec.RawArgs -eq '--expose-internals "C:\a b\index.js" --port 5599') 'quoted exe: args preserved verbatim'
check ($spec.Exe -eq 'C:\Program Files\App\App.exe') 'quoted exe: exe path preserved'
check ($spec.Pid -eq 1234) 'quoted exe: pid carried'

$bareInfo = [pscustomobject]@{
  ProcessId      = 77
  ExecutablePath = 'C:\App\App.exe'
  CommandLine    = 'C:\App\App.exe --flag "x y"'
}
$spec2 = Get-LaunchSpec $bareInfo
check ($spec2.RawArgs -eq '--flag "x y"') 'unquoted exe: args preserved verbatim'

$noArgsInfo = [pscustomobject]@{
  ProcessId      = 88
  ExecutablePath = 'C:\App\App.exe'
  CommandLine    = '"C:\App\App.exe"'
}
$spec3 = Get-LaunchSpec $noArgsInfo
check ($spec3.RawArgs -eq '') 'no-arg launch: empty args string'

$threw = $false
try {
  $bad = [pscustomobject]@{ ProcessId = 1; ExecutablePath = 'C:\App\App.exe'; CommandLine = '"D:\Other\App.exe" --x' }
  [void](Get-LaunchSpec $bad)
} catch { $threw = $true }
check $threw 'mismatched command line: refuses instead of guessing'

$threw2 = $false
try {
  $empty = [pscustomobject]@{ ProcessId = 1; ExecutablePath = 'C:\App\App.exe'; CommandLine = '' }
  [void](Get-LaunchSpec $empty)
} catch { $threw2 = $true }
check $threw2 'empty command line: refuses instead of guessing'

# --- Get-DshHomeFromRoot: <home>\profiles\<name>\node_modules\dsh-pi ----------
$d1 = Get-DshHomeFromRoot 'C:\Users\PC\.dsh\profiles\desktop\node_modules\dsh-pi'
check ($null -ne $d1 -and $d1.home -eq 'C:\Users\PC\.dsh' -and $d1.name -eq 'desktop') 'root: default home'
$d2 = Get-DshHomeFromRoot 'C:\Users\PC\Documents\pi-local\_probe\dsh-home-standalone\profiles\pi-standalone\node_modules\dsh-pi'
check ($null -ne $d2 -and $d2.home -eq 'C:\Users\PC\Documents\pi-local\_probe\dsh-home-standalone' -and $d2.name -eq 'pi-standalone') 'root: custom DSH_HOME'
check ($null -eq (Get-DshHomeFromRoot '')) 'root: empty input rejected'
check ($null -eq (Get-DshHomeFromRoot 'C:\weird\node_modules\dsh-pi')) 'root: no profiles segment rejected'
check ($null -eq (Get-DshHomeFromRoot 'C:\a\profiles\b\node_modules\other')) 'root: other package rejected'

# --- Get-EnvPatch: ELECTRON_RUN_AS_NODE only for script entry points ----------
$root = 'C:\Users\PC\.dsh\profiles\desktop\node_modules\dsh-pi'
$pScript = Get-EnvPatch $root '' '--expose-internals "C:\x\index.js" --port 5599'
check ($null -ne $pScript) 'env: patch produced for known root'
check ($pScript['DSH_HOME'] -eq 'C:\Users\PC\.dsh') 'env: DSH_HOME from root'
check ($pScript['DSH_PROFILE'] -eq 'desktop') 'env: DSH_PROFILE from root'
check ($null -eq $pScript['DSH_PORT']) 'env: DSH_PORT always cleared'
check ($pScript['ELECTRON_RUN_AS_NODE'] -eq '1') 'env: ELECTRON_RUN_AS_NODE set for .js entry'

$pGui = Get-EnvPatch $root '' ''
check ($null -eq $pGui['ELECTRON_RUN_AS_NODE']) 'env: ELECTRON_RUN_AS_NODE cleared for GUI launch'

$pOverride = Get-EnvPatch $root 'D:\custom-home' 'x.js'
check ($pOverride['DSH_HOME'] -eq 'D:\custom-home') 'env: -DshHome override wins'
check ($null -eq (Get-EnvPatch 'C:\nope\node_modules\dsh-pi' '' 'x.js')) 'env: unknown root yields no patch'

# --- Get-LaunchRootPid / Test-SelfAncestorOf on live processes -----------------
$self = Get-Process -Id $PID
$selfExe = $self.Path
$rootPid = Get-LaunchRootPid $PID $selfExe
check ($rootPid -gt 0) 'launch root: resolvable'
$rootInfo = Get-ProcInfo $rootPid
check ($null -ne $rootInfo -and $rootInfo.ExecutablePath -eq $selfExe) 'launch root: same executable'
$rootParent = if ($null -ne $rootInfo) { Get-ProcInfo ([int]$rootInfo.ParentProcessId) } else { $null }
$stops = ($null -eq $rootParent) -or ($rootParent.ExecutablePath -ne $selfExe) -or ([string]::IsNullOrWhiteSpace($rootParent.ExecutablePath))
check $stops 'launch root: stops at first different executable'

check ((Test-SelfAncestorOf $PID) -eq $true) 'ancestor: self counts'
check ((Test-SelfAncestorOf 4) -eq $false) 'ancestor: pid 4 is not an ancestor'

# --- Test-DshPiHealth: HTML 200 must not be mistaken for dsh-pi ---------------
if ($HtmlPort -gt 0) {
  $base = "http://127.0.0.1:$HtmlPort"
  check ((Test-DshPiHealth "$base/html/api/dsh-pi") -eq $false) 'health: HTML 200 rejected'
  check ((Test-DshPiHealth "$base/ok/api/dsh-pi") -eq $true) 'health: real JSON accepted'
  check ((Test-DshPiHealth "$base/bad/api/dsh-pi") -eq $false) 'health: ok=false rejected'
  check ((Test-DshPiHealth "$base/other/api/dsh-pi") -eq $false) 'health: foreign plugin rejected'
  check ((Test-DshPiHealth "$base/pi/api/dsh-pi") -eq $true) 'health: plugin=dsh-pi accepted'
  check ((Test-DshPiHealth 'http://127.0.0.1:1/api/dsh-pi') -eq $false) 'health: dead port rejected'
}

if ($script:failures -gt 0) { Write-Output "TOTAL FAILURES: $script:failures"; exit 1 }
Write-Output 'ALL OK'
exit 0
