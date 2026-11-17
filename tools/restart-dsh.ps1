# 重启 DSH 并在重启后自动核对 superpi 是否换成了磁盘上那份代码。
#
# 为什么需要单独一个脚本：插件在 import 时把代码快照进内存，不重启不生效；
# 而重启会杀掉当前会话所在的宿主进程，所以不能在对话里直接跑 —— 脚本会拦住这种情况。
#
# 用法：
#   pwsh -NoProfile -File .\tools\restart-dsh.ps1
#   pwsh -NoProfile -File .\tools\restart-dsh.ps1 -Port 5783 -Plan          # 只打印重启计划，不动任何进程
#   pwsh -NoProfile -File .\tools\restart-dsh.ps1 -Port 5783 -SkipRestart   # 只核对，不重启
#   pwsh -NoProfile -File .\tools\restart-dsh.ps1 -Profile pi-standalone -ProfileRoot <dir>
#   双击 tools\restart-dsh.bat（等价于第一条；pwsh 不在 PATH 时自动回落 powershell.exe 5.1）
#
# 退出码：0 = 版本一致；1 = 找不到实例/拿不到 pid；2 = 运行中版本与磁盘不一致；3 = 拒绝重启（见提示）
#
# 重启分支的修正（此前都是真缺陷，会让「重启」悄悄起错东西）：
#   1) 过去 Start-Process -FilePath $exe 不带任何参数。桌面实例的宿主进程命令行有 6 个参数
#      （--expose-internals、desktop-host 的 index.js、app.asar 里的 dsh 目录、profile 目录、
#      primary-runtime、pnpm.mjs、runtime\bin），丢了这些参数等于换了个东西启动。
#      现在：从目标 pid 向上找「启动根」（同 exe 的最上层祖先），把启动根的命令行原文
#      原样交给子进程（ProcessStartInfo.Arguments 不拆分不重组，引号一个字节都不变）。
#   2) 过去杀的是 /selfcheck 自报的 pid。桌面实例里那是 GUI 主进程的子进程（宿主），
#      杀了它没有谁负责重新拉起 —— 窗口还在，面板却永远起不来。现在杀启动根。
#   3) 过去直接继承当前进程的环境变量。从 DSH 集成终端/工具里跑时环境里有
#      ELECTRON_RUN_AS_NODE=1（GUI 会被当成 plain node 起，窗口不出来）以及别处的
#      DSH_HOME / DSH_PROFILE / DSH_PORT，会把实例顶到错误的 home。
#      现在按目标实例自己 /selfcheck 报的 root 反推 DSH_HOME（<home>\profiles\<name>\node_modules\superpi），
#      ELECTRON_RUN_AS_NODE 只在命令行确实是「跑一个 .js」时才设。反推不出来就拒绝重启。
#   4) 新增自保护：本脚本若正跑在目标实例内部（当前进程的祖先链里有启动根），拒绝重启并
#      说明该到外部终端双击 bat；确实要这样干可加 -Force。
param(
  [int]$Port = 0,
  [string]$Profile = 'desktop',
  [string]$ProfileRoot = (Join-Path $env:USERPROFILE '.dsh\profiles'),
  [switch]$SkipRestart,
  [switch]$Plan,
  [switch]$Force,
  [string]$DshHome = '',
  [string]$WorkingDirectory = '',
  [int]$WaitSeconds = 60
)

$ErrorActionPreference = 'Stop'

$profileDir = Join-Path $ProfileRoot $Profile

function Test-DshPiHealth([string]$base) {
  # 只认真正的 superpi：光凭 200 不够 —— 前端 dev server 对任意路径都回 200 + HTML。
  # /health 的真实响应是 JSON { ok: true, version: "x.y.z" }；HTML 会被解析成字符串。
  try {
    $body = Invoke-RestMethod -Uri "$base/health" -TimeoutSec 2 -ErrorAction Stop
  } catch { return $false }
  if ($body -is [string]) { return $false }
  if ($body.ok -ne $true) { return $false }
  $names = $body.PSObject.Properties.Name
  if ($names -contains 'plugin') { return ($body.plugin -eq 'superpi') }
  return [bool]$body.version
}

# 一个实例 = /health 的 version + /selfcheck 的 root/pid（老版本没有 selfcheck 则为 $null）
function Get-Instance([int]$port) {
  $base = "http://127.0.0.1:$port/api/superpi"
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
  # 诊断行必须走 Write-Host：Write-Output 会被 $state = Show-PluginState ... 一起收进返回值，
  # 结果就是这些行一行都看不见（0.4.1 修的就是这个）。
  Write-Host ("state.version = {0}" -f $state.version)
  Write-Host ("node          = {0} ({1})" -f $state.resolved.nodePath, $state.resolved.nodeSource)
  Write-Host ("pi cli        = {0}" -f $state.resolved.cliPath)
  Write-Host ("pi cli source = {0} version {1}" -f $state.resolved.cliSource, $state.resolved.cliVersion)
  return $state
}

function Get-ProcInfo([int]$id) {
  return Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
}

# 启动根 = 从实例 pid 向上走，直到父进程换了可执行文件。
# 桌面实例里 28720(DeepSeek Runtime.exe, GUI) → 15188(同 exe, 宿主)，根是 28720：只有它能重启整个应用。
# 探针实例是单进程，父进程是普通 shell，根就是它自己。
function Get-LaunchRootPid([int]$startPid, [string]$exePath) {
  $best = $startPid
  $cur = $startPid
  $steps = 0
  while ($steps -lt 32) {
    $steps++
    $p = Get-ProcInfo $cur
    if ($null -eq $p) { break }
    $parentId = [int]$p.ParentProcessId
    if ($parentId -le 0 -or $parentId -eq $cur) { break }
    $parent = Get-ProcInfo $parentId
    if ($null -eq $parent) { break }
    if ([string]::IsNullOrWhiteSpace($parent.ExecutablePath)) { break }
    if ([string]::IsNullOrWhiteSpace($exePath)) { break }
    if ($parent.ExecutablePath -ne $exePath) { break }
    $best = $parentId
    $cur = $parentId
  }
  return $best
}

# 从命令行原文里剥出「exe 之后的那一段」。这一段原样交给子进程，绝不拆分重组。
function Get-LaunchSpec($procInfo) {
  $exe = $procInfo.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($exe)) {
    throw "启动根 pid $($procInfo.ProcessId) 的 ExecutablePath 取不到，无法重建启动命令。"
  }
  $cl = $procInfo.CommandLine
  if ([string]::IsNullOrWhiteSpace($cl)) {
    throw "启动根 pid $($procInfo.ProcessId) 的 CommandLine 取不到（需要相应权限），无法无损重建。"
  }
  $raw = $null
  $quoted = '"' + $exe + '"'
  if ($cl.StartsWith($quoted, [System.StringComparison]::OrdinalIgnoreCase)) {
    $raw = $cl.Substring($quoted.Length)
  } elseif ($cl.StartsWith($exe, [System.StringComparison]::OrdinalIgnoreCase)) {
    $raw = $cl.Substring($exe.Length)
  } else {
    throw "命令行不以可执行文件路径开头，无法无损重建：$cl"
  }
  return [pscustomobject]@{
    Pid     = [int]$procInfo.ProcessId
    Exe     = $exe
    RawArgs = $raw.Trim()
  }
}

# <home>\profiles\<name>\node_modules\superpi → home 与 name
function Get-DshHomeFromRoot([string]$root) {
  if ([string]::IsNullOrWhiteSpace($root)) { return $null }
  $p = $root.TrimEnd('\')
  $suffix = '\node_modules\superpi'
  if (-not $p.EndsWith($suffix, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
  $profileDirPath = $p.Substring(0, $p.Length - $suffix.Length)
  $name = Split-Path -Path $profileDirPath -Leaf
  $profilesDir = Split-Path -Path $profileDirPath -Parent
  if ([string]::IsNullOrWhiteSpace($profilesDir)) { return $null }
  if ((Split-Path -Path $profilesDir -Leaf) -ne 'profiles') { return $null }
  $homeDir = Split-Path -Path $profilesDir -Parent
  if ([string]::IsNullOrWhiteSpace($homeDir)) { return $null }
  return @{ home = $homeDir; name = $name }
}

# 子进程该带哪些环境变量：只设这三/四个，其余一律不碰（尤其不继承 ELECTRON_RUN_AS_NODE）。
function Get-EnvPatch([string]$instanceRoot, [string]$homeOverride, [string]$rawArgs) {
  $homeDir = $null
  $name = $null
  if (-not [string]::IsNullOrWhiteSpace($homeOverride)) {
    $homeDir = $homeOverride
  } else {
    $derived = Get-DshHomeFromRoot $instanceRoot
    if ($null -ne $derived) { $homeDir = $derived.home; $name = $derived.name }
  }
  if ([string]::IsNullOrWhiteSpace($homeDir)) { return $null }
  $patch = [ordered]@{}
  $patch['DSH_HOME'] = $homeDir
  if (-not [string]::IsNullOrWhiteSpace($name)) { $patch['DSH_PROFILE'] = $name }
  $patch['DSH_PORT'] = $null
  if ($rawArgs -match '(?i)\.(js|mjs|cjs)("|\s|$)') {
    $patch['ELECTRON_RUN_AS_NODE'] = '1'
  } else {
    $patch['ELECTRON_RUN_AS_NODE'] = $null
  }
  return $patch
}

function Show-Plan($spec, [int]$instancePid, [string]$workDir, $patch) {
  Write-Output '重启计划：'
  Write-Output ("  实例 pid     = {0}（/selfcheck 自报，或端口占用者）" -f $instancePid)
  Write-Output ("  启动根 pid   = {0}" -f $spec.Pid)
  Write-Output ("  exe          = {0}" -f $spec.Exe)
  $shown = if ($spec.RawArgs.Length -gt 0) { $spec.RawArgs } else { '<无参数>' }
  Write-Output ("  命令行参数   = {0}" -f $shown)
  Write-Output ("  工作目录     = {0}" -f $workDir)
  if ($null -eq $patch) {
    Write-Output '  环境变量     = 反推不出 DSH_HOME（该实例 /selfcheck 没报 root？）→ 拒绝重启，用 -DshHome 指定'
    return
  }
  foreach ($k in @($patch.Keys)) {
    $v = $patch[$k]
    $shownValue = if ($null -eq $v) { '<从环境里移除>' } else { $v }
    Write-Output ("  环境 {0} = {1}" -f $k, $shownValue)
  }
}

# Start-Process 不支持单次调用改环境，只能改本进程再还原；用 UseShellExecute=false + 原文参数，
# 参数里的引号因此一个字节都不会被重新解释。
function Start-LaunchSpec($spec, [string]$workDir, $patch) {
  $saved = @{}
  try {
    if ($null -ne $patch) {
      foreach ($k in @($patch.Keys)) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        $v = $patch[$k]
        if ($null -eq $v) { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }
        else { [Environment]::SetEnvironmentVariable($k, [string]$v, 'Process') }
      }
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $spec.Exe
    if ($spec.RawArgs.Length -gt 0) { $psi.Arguments = $spec.RawArgs }
    $psi.WorkingDirectory = $workDir
    $psi.UseShellExecute = $false
    return [System.Diagnostics.Process]::Start($psi)
  } finally {
    foreach ($k in @($saved.Keys)) {
      if ($null -eq $saved[$k]) { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }
      else { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    }
  }
}

# 当前进程是不是跑在某个 pid 内部（祖先链里有没有它）
function Test-SelfAncestorOf([int]$pidToFind) {
  $cur = $PID
  $steps = 0
  while ($cur -gt 0 -and $steps -lt 64) {
    if ($cur -eq $pidToFind) { return $true }
    $p = Get-ProcInfo $cur
    if ($null -eq $p) { break }
    $next = [int]$p.ParentProcessId
    if ($next -le 0 -or $next -eq $cur) { break }
    $cur = $next
    $steps++
  }
  return $false
}

# 主流程。库模式（$env:SUPERPI_RESTART_LIB = 1）只加载上面的函数，供 test/restart-lib.mjs 做单元测试；
# 不这么做就只能靠真起真杀来验证重启分支，测试既慢又会动用户正在用的实例。
function Invoke-RestartMain {
  Write-Output "profile = $profileDir"

  $resolved = Resolve-Target $Port $profileDir
  if ($null -eq $resolved) {
    $dsh = @(Get-Process -Name 'DeepSeek*' -ErrorAction SilentlyContinue)
    if ($dsh.Count -eq 0) {
      Write-Output 'DeepSeek Runtime.exe 没在跑 —— 先启动 DSH 再试。'
    } else {
      Write-Output "有 $($dsh.Count) 个 DeepSeek 进程在跑，但没有任何端口回 /api/superpi/health。"
      Write-Output '可能是宿主还在启动，或者 superpi 没装进这个 profile。'
    }
    exit 1
  }
  if ($null -eq $resolved.inst) {
    Write-Output ("目标实例不明确：" + $resolved.reason)
    Show-Instances $resolved.all
    Write-Output '用 -Port <端口> 指定要核对的实例。'
    exit 1
  }

  $target = $resolved.inst
  Write-Output ("api base = {0}  (匹配依据：{1})" -f $target.Base, $resolved.reason)
  if ($resolved.all.Count -gt 1) {
    Write-Output '本机其它 superpi 实例（不参与本次核对）：'
    Show-Instances @($resolved.all | Where-Object { $_.Port -ne $target.Port })
  }

  if (-not $SkipRestart) {
    $instancePid = $target.Pid
    if ($null -eq $instancePid) {
      $conn = Get-NetTCPConnection -State Listen -LocalPort $target.Port -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($conn) { $instancePid = [int]$conn.OwningProcess }
    }
    if ($null -eq $instancePid) { Write-Output '拿不到目标实例的 pid，无法只重启它。'; exit 1 }

    $instProc = Get-ProcInfo $instancePid
    if ($null -eq $instProc) { Write-Output "pid $instancePid 已经不存在了（/selfcheck 的是旧值？）。"; exit 1 }

    $rootPid = Get-LaunchRootPid $instancePid $instProc.ExecutablePath
    $rootProc = if ($rootPid -eq $instancePid) { $instProc } else { Get-ProcInfo $rootPid }
    if ($null -eq $rootProc) { Write-Output "启动根 pid $rootPid 取不到进程信息。"; exit 1 }

    $spec = Get-LaunchSpec $rootProc
    $patch = Get-EnvPatch $target.Root $DshHome $spec.RawArgs
    $workDir = if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) { Split-Path -Path $spec.Exe -Parent } else { $WorkingDirectory }

    Show-Plan $spec $instancePid $workDir $patch

    if ($Plan) {
      Write-Output '（-Plan：只打印计划，没有动任何进程）'
      exit 0
    }
    if ($null -eq $patch) {
      Write-Output '拒绝重启：算不出这个实例的 DSH_HOME，照现状启动可能把它顶到别的 home。'
      Write-Output '  用 -DshHome <目录> 显式指定该实例的 DSH_HOME 再跑。'
      exit 3
    }
    if ((Test-SelfAncestorOf $rootPid) -and -not $Force) {
      Write-Output ("拒绝重启：本脚本正跑在 pid {0} 内部（它的子孙进程），重启会把自己连同当前会话一起杀掉。" -f $rootPid)
      Write-Output '  到一个独立的终端窗口跑，或直接双击 tools\restart-dsh.bat。'
      Write-Output '  确实要从实例内部重启，加 -Force。'
      exit 3
    }

    Write-Output ("正在重启：kill 启动根 pid {0}，等端口 {1} 释放…" -f $rootPid, $target.Port)
    $proc = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
    if ($null -ne $proc) {
      $proc.CloseMainWindow() | Out-Null
      Start-Sleep -Seconds 4
      if (-not $proc.HasExited) { Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue }
    }
    $freeDeadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $freeDeadline) {
      $listen = Get-NetTCPConnection -State Listen -LocalPort $target.Port -ErrorAction SilentlyContinue
      if (-not $listen) { break }
      Start-Sleep -Milliseconds 500
    }

    $child = Start-LaunchSpec $spec $workDir $patch
    Write-Output ("已重新拉起：pid {0}，等待最多 {1} 秒直到 /api/superpi/health 就绪…" -f $child.Id, $WaitSeconds)
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $target = $null
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 2
      $again = Resolve-Target $Port $profileDir
      if ($null -ne $again -and $null -ne $again.inst) { $target = $again.inst; break }
    }
    if ($null -eq $target) { Write-Output '重启后没等到 /api/superpi 就绪。'; exit 1 }
    Write-Output ("api base = {0}" -f $target.Base)
  }

  $state = Show-PluginState $target.Base

  # 磁盘版本必须来自「这个实例自己加载的那份代码」，不能硬编码 desktop 路径：
  # 探针 profile / 自定义 DSH_HOME 的实例会拿到同一台机器上另一份代码的版本，误报不一致。
  $diskPkg = $null
  if ($null -ne $target.Root) { $diskPkg = Join-Path $target.Root 'package.json' }
  if ($null -eq $diskPkg -or -not (Test-Path -LiteralPath $diskPkg)) {
    $fallback = Join-Path $profileDir 'node_modules\superpi\package.json'
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
  Write-Output '  成因 B：重启过但旧进程没退干净。看上面「本机其它 superpi 实例」，确认没有旧实例占着端口。'
  exit 2
}

if ($env:SUPERPI_RESTART_LIB -ne '1') {
  Invoke-RestartMain
}
