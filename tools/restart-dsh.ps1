# 重启 DSH 并在重启后自动核对 dsh-pi 是否换成了磁盘上那份代码。
#
# 为什么需要单独一个脚本：插件在 import 时把代码快照进内存，不重启不生效；
# 而重启会杀掉当前会话所在的宿主进程，所以不能在对话里直接跑。
#
# 用法：
#   pwsh -NoProfile -File .\tools\restart-dsh.ps1
#   pwsh -NoProfile -File .\tools\restart-dsh.ps1 -Port 5783 -SkipRestart   # 只核对，不重启
#   pwsh -NoProfile -File .\tools\restart-dsh.ps1 -Profile pi-standalone -ProfileRoot <dir>
#
# 0.4.1 修正（两个真实缺陷）：
#   1) 不指定端口时，过去按端口升序取第一个能回 /health 的实例。本机同时跑着
#      desktop(5783, 0.4.0) 与探针实例(5599, 0.4.1) 时，会拿到探针实例的版本去和
#      desktop 的磁盘版本比对，误报 MISMATCH。现在按 profile 归属挑实例。
#   2) 过去比对的是硬编码的 ~\.dsh\profiles\desktop 磁盘版本，与被查实例可能不是同一份
#      代码。现在用实例自己 /selfcheck 报的 root 去读 package.json，版本与代码同源。
#   3) 重启过去会杀掉所有 DeepSeek* 进程（连同别的 profile 实例）。现在只杀目标实例。
param(
  [int]$Port = 0,
  [string]$Profile = 'desktop',
  [string]$ProfileRoot = (Join-Path $env:USERPROFILE '.dsh\profiles'),
  [switch]$SkipRestart,
  [int]$WaitSeconds = 60
)

$ErrorActionPreference = 'Stop'

$profileDir = Join-Path $ProfileRoot $Profile

function Get-DshExe {
  $proc = Get-Process -Name 'DeepSeek*' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $proc) { return $null }
  return $proc.Path
}

function Test-DshPiHealth([string]$base) {
  # 只认真正的 dsh-pi：光凭 200 不够 —— 前端 dev server 对任意路径都回 200 + HTML。
  # /health 的真实响应是 JSON { ok: true, version: "x.y.z" }；HTML 会被解析成字符串。
  try {
    $body = Invoke-RestMethod -Uri "$base/health" -TimeoutSec 2 -ErrorAction Stop
  } catch { return $false }
  if ($body -is [string]) { return $false }
  if ($body.ok -ne $true) { return $false }
  $names = $body.PSObject.Properties.Name
  if ($names -contains 'plugin') { return ($body.plugin -eq 'dsh-pi') }
  return [bool]$body.version
}

# 一个实例 = /health 的 version + /selfcheck 的 root/pid（老版本没有 selfcheck 则为 $null）
function Get-Instance([int]$port) {
  $base = "http://127.0.0.1:$port/api/dsh-pi"
  if (-not (Test-DshPiHealth $base)) { return $null }
  $health = Invoke-RestMethod -Uri "$base/health" -TimeoutSec 4
  $root = $null
  $pidValue = $null
  try {
    $sc = Invoke-RestMethod -Uri "$base/selfcheck" -TimeoutSec 6
    if ($sc -ne $null -and $sc.PSObject.Properties.Name -contains 'root') { $root = $sc.root }
    if ($sc -ne $null -and $sc.process -ne $null) { $pidValue = $sc.process.pid }
  } catch { }
  return [pscustomobject]@{
    Port    = $port
    Base    = $base
    Version = $health.version
    Root    = $root
    Pid     = $pidValue
  }
}

function Get-Instances {
  # 只探 DeepSeek 进程占用的端口，别的监听端口一律跳过（比全端口扫描快且不会误伤）
  $conns = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') } |
    Sort-Object LocalPort -Unique
  $list = New-Object System.Collections.Generic.List[object]
  foreach ($c in $conns) {
    $owner = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    if ($null -eq $owner) { continue }
    if ($owner.ProcessName -notlike 'DeepSeek*') { continue }
    $inst = Get-Instance $c.LocalPort
    if ($null -ne $inst) { $list.Add($inst) }
  }
  return $list
}

function Test-UnderProfile($inst, [string]$dir) {
  if ($null -eq $inst.Root) { return $false }
  $root = $inst.Root.TrimEnd('\')
  $want = $dir.TrimEnd('\')
  return $root.StartsWith($want, [System.StringComparison]::OrdinalIgnoreCase)
}

function Resolve-Target([int]$port, [string]$dir) {
  if ($port -gt 0) {
    $one = Get-Instance $port
    if ($null -eq $one) { return $null }
    return @{ inst = $one; all = @($one); reason = "指定端口 $port" }
  }
  $all = @(Get-Instances)
  if ($all.Count -eq 0) { return $null }
  $mine = @($all | Where-Object { Test-UnderProfile $_ $dir })
  if ($mine.Count -eq 1) { return @{ inst = $mine[0]; all = $all; reason = "profile 归属 $dir" } }
  if ($mine.Count -gt 1) { return @{ inst = $null; all = $all; reason = "多个实例同属 $dir" } }
  if ($all.Count -eq 1) { return @{ inst = $all[0]; all = $all; reason = '唯一实例（root 未知，按老版本处理）' } }
  return @{ inst = $null; all = $all; reason = "没有实例属于 $dir" }
}

function Show-Instances($all) {
  foreach ($i in $all) {
    Write-Output ("  port {0}  version {1}  pid {2}  root {3}" -f $i.Port, $i.Version, $i.Pid, $i.Root)
  }
}

function Show-PluginState([string]$base) {
  $state = Invoke-RestMethod -Uri "$base/state" -TimeoutSec 8
  # 诊断行必须走 Write-Host：Write-Output 会被 `$state = Show-PluginState ...` 一起收进返回值，
  # 结果就是这些行一行都看不见（0.4.1 修的就是这个）。
  Write-Host ("state.version = {0}" -f $state.version)
  Write-Host ("node          = {0} ({1})" -f $state.resolved.nodePath, $state.resolved.nodeSource)
  Write-Host ("pi cli        = {0}" -f $state.resolved.cliPath)
  Write-Host ("pi cli source = {0} version {1}" -f $state.resolved.cliSource, $state.resolved.cliVersion)
  return $state
}

$exe = Get-DshExe
if ($null -eq $exe) { Write-Error 'DSH is not running.'; exit 1 }
Write-Output "dsh exe = $exe"
Write-Output "profile = $profileDir"

$resolved = Resolve-Target $Port $profileDir
if ($null -eq $resolved) {
  Write-Error "没有找到在跑的 /api/dsh-pi 实例（profile $profileDir）。先启动 DSH 再试。"
  exit 1
}
if ($null -eq $resolved.inst) {
  Write-Output ("目标实例不明确：" + $resolved.reason)
  Show-Instances $resolved.all
  Write-Error '用 -Port <端口> 指定要核对的实例。'
  exit 1
}

$target = $resolved.inst
Write-Output ("api base = {0}  (匹配依据：{1})" -f $target.Base, $resolved.reason)
if ($resolved.all.Count -gt 1) {
  Write-Output '本机其它 dsh-pi 实例（不参与本次核对）：'
  Show-Instances @($resolved.all | Where-Object { $_.Port -ne $target.Port })
}

if (-not $SkipRestart) {
  $killPid = $target.Pid
  if ($null -eq $killPid) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $target.Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { $killPid = $conn.OwningProcess }
  }
  if ($null -eq $killPid) { Write-Error '拿不到目标实例的 pid，无法只重启它。'; exit 1 }
  Write-Output "正在重启 DSH（只杀 pid $killPid，其它实例不动）…"
  $proc = Get-Process -Id $killPid -ErrorAction SilentlyContinue
  if ($proc) {
    $proc.CloseMainWindow() | Out-Null
    Start-Sleep -Seconds 6
    if (-not $proc.HasExited) { Stop-Process -Id $killPid -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Seconds 3
  Start-Process -FilePath $exe
  Write-Output "已重新拉起，等待最多 $WaitSeconds 秒直到 /api/dsh-pi/health 就绪…"
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $target = $null
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $again = Resolve-Target $Port $profileDir
    if ($null -ne $again -and $null -ne $again.inst) { $target = $again.inst; break }
  }
  if ($null -eq $target) { Write-Error '重启后没等到 /api/dsh-pi 就绪。'; exit 1 }
  Write-Output ("api base = {0}" -f $target.Base)
}

$state = Show-PluginState $target.Base

# 磁盘版本必须来自「这个实例自己加载的那份代码」，不能硬编码 desktop 路径：
# 探针 profile / 自定义 DSH_HOME 的实例会拿到同一台机器上另一份代码的版本，误报不一致。
$diskPkg = $null
if ($null -ne $target.Root) { $diskPkg = Join-Path $target.Root 'package.json' }
if ($null -eq $diskPkg -or -not (Test-Path -LiteralPath $diskPkg)) {
  $fallback = Join-Path $profileDir 'node_modules\dsh-pi\package.json'
  if (Test-Path -LiteralPath $fallback) { $diskPkg = $fallback }
}
$diskVersion = if ($diskPkg -and (Test-Path -LiteralPath $diskPkg)) { (Get-Content -LiteralPath $diskPkg -Raw | ConvertFrom-Json).version } else { '<missing>' }
Write-Output ("disk package  = {0}" -f $diskPkg)
Write-Output ("disk version  = {0}" -f $diskVersion)

if ($state.version -eq $diskVersion) {
  Write-Output 'OK: 运行中的插件版本与磁盘一致'
  exit 0
}

# 不一致有两种成因，输出里要能一眼分开，否则用户只能猜：
#  a) 磁盘刚换了新版本，宿主还是旧进程 —— 加 -SkipRestart 核对时就是这种，跑一次不带该开关的重启即可；
#  b) 重启过但旧进程没退干净（端口被别的 profile 实例占着）。
Write-Output ("MISMATCH: 运行中的插件版本 {0} ≠ 磁盘版本 {1}" -f $state.version, $diskVersion)
Write-Output '  成因 A：磁盘刚装了新版本、宿主还没重启（-SkipRestart 只核对不重启，就是这个情况）。'
Write-Output '          去掉 -SkipRestart 再跑一次即可（或双击 tools\restart-dsh.bat）。'
Write-Output '  成因 B：重启过但旧进程没退干净。看上面「本机其它 dsh-pi 实例」，确认没有旧实例占着端口。'
exit 2
