# 重启 DSH 并在重启后自动核对 dsh-pi 是否换成了磁盘上那份代码。
#
# 为什么需要单独一个脚本：插件在 import 时把代码快照进内存，不重启不生效；
# 而重启会杀掉当前会话所在的宿主进程，所以不能在对话里直接跑。
#
# 用法：
#   pwsh -NoProfile -File .\tools\restart-dsh.ps1
#   pwsh -NoProfile -File .\tools\restart-dsh.ps1 -Port 5495 -SkipRestart   # 只核对，不重启
param(
  [int]$Port = 0,
  [switch]$SkipRestart,
  [int]$WaitSeconds = 40
)

$ErrorActionPreference = 'Stop'

function Get-DshExe {
  $proc = Get-Process -Name 'DeepSeek*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $proc) { return $null }
  return $proc.Path
}

function Get-ApiBase([int]$port) {
  if ($port -gt 0) { return "http://127.0.0.1:$port/api/dsh-pi" }
  # 不指定端口时，从正在监听的端口里找能回 /api/dsh-pi/health 的那个
  $conns = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') } |
    Select-Object -ExpandProperty LocalPort -Unique
  foreach ($p in $conns) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/api/dsh-pi/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
      if ($r.StatusCode -eq 200) { return "http://127.0.0.1:$p/api/dsh-pi" }
    } catch { }
  }
  return $null
}

function Show-PluginState([string]$base) {
  $state = Invoke-RestMethod -Uri "$base/state" -TimeoutSec 8
  Write-Output ("state.version = {0}" -f $state.version)
  Write-Output ("node          = {0} ({1})" -f $state.resolved.nodePath, $state.resolved.nodeSource)
  Write-Output ("pi cli        = {0}" -f $state.resolved.cliPath)
  Write-Output ("pi cli source = {0} version {1}" -f $state.resolved.cliSource, $state.resolved.cliVersion)
  return $state
}

$exe = Get-DshExe
if ($null -eq $exe) { Write-Error 'DSH is not running.'; exit 1 }
Write-Output "dsh exe = $exe"

if (-not $SkipRestart) {
  Write-Output '正在重启 DSH…'
  Get-Process -Name 'DeepSeek*' -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }
  Start-Sleep -Seconds 6
  Get-Process -Name 'DeepSeek*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  Start-Process -FilePath $exe
  Write-Output "已重新拉起，等待最多 $WaitSeconds 秒直到 /api/dsh-pi/health 就绪…"
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $base = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $base = Get-ApiBase $Port
    if ($null -ne $base) { break }
  }
} else {
  $base = Get-ApiBase $Port
}

if ($null -eq $base) { Write-Error 'Could not find a listening /api/dsh-pi after the wait.'; exit 1 }
Write-Output "api base = $base"

$state = Show-PluginState $base

$pkgPath = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-pi\package.json'
$diskVersion = if (Test-Path $pkgPath) { (Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json).version } else { '<missing>' }
Write-Output "disk version  = $diskVersion"

if ($state.version -eq $diskVersion) {
  Write-Output 'OK: 运行中的插件版本与磁盘一致'
  exit 0
} else {
  Write-Output 'MISMATCH: 运行中的插件版本与磁盘不一致（多半是还有旧进程没退干净）'
  exit 2
}
