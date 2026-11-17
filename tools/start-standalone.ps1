<#
.SYNOPSIS
  一键启动 superpi 独立实例（不碰桌面 profile，双击 .bat 即用）。

.DESCRIPTION
  这是「只想看看面板长什么样」的最短路径：建一个独立的 DSH_HOME、把当前仓库的
  superpi 装进去、用 DSH 自己的 Electron Node 起 web 服务，然后把访问地址打出来。

  与 tools/standalone-verify.ps1 的分工：
    - 本脚本：常驻启动器。装一次、之后复用；自己管端口与进程，配 -Stop 关停。
    - standalone-verify.ps1：一次性自证。每次都从空 DSH_HOME 重装、跑完 LLM 往返就删。

  位置无关：所有路径从 $PSScriptRoot 推导，不含任何本机绝对路径。
  状态目录：<repo>/.standalone/（已 gitignore），放 DSH_HOME 与日志，可随时删。

.PARAMETER Port
  监听端口，默认 25117。换端口只需 -Port，端口号不写进任何持久文件。

.PARAMETER Stop
  停掉本脚本启动的实例（按 .standalone/instance.json 记的 pid + 端口），然后退出。

.PARAMETER Status
  只报告当前状态（进程在不在、/health 通不通），不做任何变更。

.PARAMETER Reinstall
  忽略 .standalone 里已有的安装，重新 pnpm add（升级插件后用）。

.PARAMETER WaitSeconds
  等待 /health 就绪的上限秒数，默认 120。

.PARAMETER KeepOpen
  就绪后不退出，前台守着子进程（关掉窗口即停）。默认就绪后打印地址即返回。

.EXAMPLE
  .\tools\start-standalone.bat
  .\tools\start-standalone.bat -Port 25117 -Reinstall
  .\tools\start-standalone.bat -Status
  .\tools\start-standalone.bat -Stop
#>
[CmdletBinding()]
param(
  [int]$Port = 25117,
  [switch]$Stop,
  [switch]$Status,
  [switch]$Reinstall,
  [int]$WaitSeconds = 120,
  [switch]$KeepOpen,
  [string]$PnpmPath = '',
  [string]$DshExe = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ── 路径：全部从脚本位置推导，禁止硬编码 ──────────────────────────────────
# PluginRoot = tools/ 的上一级
$PluginRoot = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $PluginRoot '.standalone'
$StateFile = Join-Path $StateDir 'instance.json'
$LogDir = Join-Path $StateDir 'logs'
$ProfileName = 'pi-standalone'
$HomeDir = Join-Path $StateDir 'dsh-home'
$ProfileDir = Join-Path $HomeDir ('profiles\' + $ProfileName)

function Step([string]$text) { Write-Host ('[start] ' + $text) }
function Warn([string]$text) { Write-Host ('[start] WARN: ' + $text) -ForegroundColor Yellow }
function Fail([string]$text) { Write-Host ('[start] FAILED: ' + $text) -ForegroundColor Red; exit 2 }

function Get-ListeningPid([int]$p) {
  $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return [int]$conn.OwningProcess }
  return 0
}

function Test-Health([int]$p) {
  try {
    $h = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $p + '/api/superpi/health') -TimeoutSec 3
    return [bool]$h.ok
  } catch { return $false }
}

function Read-State {
  if (-not (Test-Path -LiteralPath $StateFile)) { return $null }
  try { return (Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json) } catch { return $null }
}

function Write-State($obj) {
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  $obj | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $StateFile -Encoding utf8
}

# ── -Status / -Stop：先处理，二者都不需要解析 DSH 可执行 ───────────────────
if ($Status) {
  $st = Read-State
  $listenPid = Get-ListeningPid $Port
  $healthy = Test-Health $Port
  Step ("state file   = " + $(if ($st) { $StateFile } else { '(none)' }))
  if ($st) {
    Step ("recorded pid = " + $st.pid + " (alive=" + [bool](Get-Process -Id $st.pid -ErrorAction SilentlyContinue) + ")")
    Step ("recorded port= " + $st.port)
    Step ("url          = " + $st.url)
  }
  Step ("port " + $Port + " listen pid = " + $(if ($listenPid -gt 0) { $listenPid } else { '(free)' }))
  Step ("health       = " + $(if ($healthy) { 'ok' } else { 'not reachable' }))
  exit 0
}

if ($Stop) {
  $st = Read-State
  $stopped = 0
  $targets = @()
  if ($st -and $st.pid) { $targets += [int]$st.pid }
  $listenPid = Get-ListeningPid $(if ($st -and $st.port) { [int]$st.port } else { $Port })
  if ($listenPid -gt 0 -and ($targets -notcontains $listenPid)) { $targets += $listenPid }
  foreach ($t in $targets) {
    $proc = Get-Process -Id $t -ErrorAction SilentlyContinue
    if (-not $proc) { Step ("pid " + $t + " already gone"); continue }
    # /T 带上子进程（Electron 会派生多个），否则主进程退出后 child 仍占端口。
    & taskkill /T /F /PID $t 2>&1 | Out-Null
    $stopped++
    Step ("stopped pid " + $t + " (" + $proc.ProcessName + ")")
  }
  if ($stopped -eq 0) { Step 'nothing to stop' }
  if (Test-Path -LiteralPath $StateFile) { Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 600
  $still = Get-ListeningPid $Port
  if ($still -gt 0) { Warn ("port " + $Port + " still held by pid " + $still + " (不是本脚本启动的实例？)") }
  else { Step ("port " + $Port + " released") }
  exit 0
}

# ── 解析 DSH 可执行 与 pnpm ───────────────────────────────────────────────
function Resolve-DshExe([string]$explicit) {
  if ($explicit -ne '') {
    if (-not (Test-Path -LiteralPath $explicit)) { throw "DeepSeek Runtime 不存在：$explicit" }
    return $explicit
  }
  # 1) 从正在运行的桌面实例取（最可靠：path 一定是真的）
  $proc = Get-Process -Name 'DeepSeek*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and (Test-Path -LiteralPath $_.Path) } | Select-Object -First 1
  if ($proc) { return $proc.Path }
  # 2) 常见安装位置
  $guess = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Runtime\DeepSeek Runtime.exe'
  if (Test-Path -LiteralPath $guess) { return $guess }
  throw 'DeepSeek Runtime 可执行文件未找到：请先启动一次桌面版，或用 -DshExe 指定'
}

function Resolve-Pnpm([string]$explicit) {
  if ($explicit -ne '') {
    if (-not (Test-Path -LiteralPath $explicit)) { throw "pnpm 不存在：$explicit" }
    return $explicit
  }
  $local = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
  if (Test-Path -LiteralPath $local) { return $local }
  $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -like '*.cjs') { return $cmd.Source }
  throw 'pnpm 未找到：请用 -PnpmPath 指定 pnpm.cjs（不要用 PATH 上的 pnpm.ps1，那是 corepack shim）'
}

$dshExePath = Resolve-DshExe $DshExe
$asar = Join-Path (Split-Path $dshExePath) 'resources\app.asar'
if (-not (Test-Path -LiteralPath $asar)) { Fail "app.asar not found: $asar" }
# app.asar 在 OS 视角是单个文件，内部路径 Test-Path 恒 false；内部路径交给 Electron 解析。
$cli = Join-Path $asar 'dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail 'node.exe 未找到' }

Step ("plugin root = " + $PluginRoot)
Step ("dsh exe     = " + $dshExePath)
Step ("state dir   = " + $StateDir)

# ── 已经起过同一端口：直接报告，不重复启动 ────────────────────────────────
$existingListen = Get-ListeningPid $Port
if ($existingListen -gt 0 -and -not $Reinstall) {
  $st = Read-State
  if ($st -and [int]$st.port -eq $Port -and (Test-Health $Port)) {
    Step ("already running (pid " + $existingListen + ")")
    Step ("api          = " + $st.url + '/api/superpi')
    Step ("version      = " + $st.version)
    Step ("home         = " + $st.home)
    Step ("log          = " + $st.log)
    Step ('stop with:  .\tools\start-standalone.bat -Stop')
    Write-Output $st.url
    exit 0
  }
  Fail ("port " + $Port + " 已被 pid " + $existingListen + " 占用，且不是本脚本记录的实例。请换 -Port，或先关掉它。")
}

New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ── 装 superpi 到独立 DSH_HOME（只在缺失或 -Reinstall 时做）────────────────
$pkg = Get-Content -LiteralPath (Join-Path $PluginRoot 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$tgz = Join-Path $PluginRoot ('superpi-' + $version + '.tgz')
$installedIndex = Join-Path $ProfileDir ('node_modules\superpi\index.js')
$installedVersionFile = Join-Path $ProfileDir 'node_modules\superpi\package.json'

$needInstall = $Reinstall.IsPresent -or (-not (Test-Path -LiteralPath $installedIndex))
if (-not $needInstall) {
  # 版本不一致也要重装，否则面板跑的是旧代码（pnpm 按 lock integrity 复用 store，不升版本会装回旧内容）。
  $installedVersion = $null
  try { $installedVersion = (Get-Content -LiteralPath $installedVersionFile -Raw | ConvertFrom-Json).version } catch { }
  if ($installedVersion -ne $version) {
    Step ("installed " + $installedVersion + " != repo " + $version + ", reinstalling")
    $needInstall = $true
  }
}

if ($needInstall) {
  $pnpm = Resolve-Pnpm $PnpmPath
  Step ("pnpm         = " + $pnpm)
  if (-not (Test-Path -LiteralPath $tgz)) {
    Step ("packing superpi " + $version)
    Push-Location -LiteralPath $PluginRoot
    try {
      & npm pack --silent | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail 'npm pack 失败' }
    } finally { Pop-Location }
  }
  if (-not (Test-Path -LiteralPath $tgz)) { Fail ("tarball 缺失：" + $tgz) }
  Step ("tarball      = " + $tgz + " (" + (Get-Item -LiteralPath $tgz).Length + " B)")

  New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
  $manifest = [ordered]@{
    name = "dsh-profile-$ProfileName"
    private = $true
    dependencies = [ordered]@{}
    dsh = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') } }
  }
  Set-Content -LiteralPath (Join-Path $ProfileDir 'package.json') -Value ($manifest | ConvertTo-Json -Depth 8) -Encoding utf8
  Set-Content -LiteralPath (Join-Path $ProfileDir 'cordis.yml') -Value (@('# dsh profile root - an empty entry list patched over by the layers above.', '[]', '') -join [Environment]::NewLine) -Encoding utf8
  Set-Content -LiteralPath (Join-Path $ProfileDir 'pnpm-workspace.yaml') -Value (@('packages:', '  - .', '', 'nodeLinker: hoisted', 'autoInstallPeers: false', '') -join [Environment]::NewLine) -Encoding utf8
  Set-Content -LiteralPath (Join-Path $ProfileDir 'cordis.patch.yml') -Value (@('# superpi one-click start: the only third-party plugin in this profile', '- insert:', '    - id: superpi', '      name: superpi', '      config: {}', '') -join [Environment]::NewLine) -Encoding utf8

  Step 'installing superpi with pnpm (first run only, may take a while)'
  $spec = 'file:' + ($tgz -replace '\\', '/')
  Push-Location -LiteralPath $ProfileDir
  try {
    & $node $pnpm add $spec --ignore-scripts --config.auto-install-peers=false --config.minimum-release-age=0 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'pnpm add 失败' }
  } finally { Pop-Location }

  if (-not (Test-Path -LiteralPath $installedIndex)) { Fail '安装后找不到 superpi/index.js' }
  $piCli = Join-Path $ProfileDir 'node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js'
  if (-not (Test-Path -LiteralPath $piCli)) { Fail '安装后找不到 @earendil-works/pi-coding-agent' }
  Step ('installed superpi ' + $version + ' + pi runtime')
} else {
  Step ('reusing installed superpi ' + $version)
}

# ── 启动 ────────────────────────────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $LogDir ('standalone-' + $stamp + '.log')
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = $HomeDir
# 残留的 DSH_PROFILE / DSH_PORT 会把实例顶到错误位置，一律清掉。
Remove-Item Env:\DSH_PROFILE -ErrorAction SilentlyContinue
Remove-Item Env:\DSH_PORT -ErrorAction SilentlyContinue

Step ("booting profile " + $ProfileName + " on port " + $Port)
# -ArgumentList 传数组时 PowerShell 会裸拼，遇空格路径会断；必须自己加引号拼成一个字符串。
$bootArgs = '"' + $cli + '" ' + $ProfileName + ' --port ' + $Port + ' --no-open'
$proc = Start-Process -FilePath $dshExePath -ArgumentList $bootArgs -PassThru `
  -RedirectStandardOutput $logPath -RedirectStandardError ($logPath + '.err')
Step ("pid          = " + $proc.Id)

$base = 'http://127.0.0.1:' + $Port
$apiBase = $base + '/api/superpi'
$sw = [Diagnostics.Stopwatch]::StartNew()
$ready = $false
while ($sw.Elapsed.TotalSeconds -lt $WaitSeconds) {
  if ($proc.HasExited) {
    Warn ("进程已退出（exit " + $proc.ExitCode + "），日志：" + $logPath)
    if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Tail 20 }
    if (Test-Path -LiteralPath ($logPath + '.err')) { Get-Content -LiteralPath ($logPath + '.err') -Tail 20 }
    Fail '启动失败'
  }
  try {
    $h = Invoke-RestMethod -Uri ($apiBase + '/health') -TimeoutSec 3
    if ($h.ok) { $ready = $true; break }
  } catch { }
  Start-Sleep -Milliseconds 700
}
if (-not $ready) {
  if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Tail 20 }
  if (Test-Path -LiteralPath ($logPath + '.err')) { Get-Content -LiteralPath ($logPath + '.err') -Tail 20 }
  & taskkill /T /F /PID $proc.Id 2>&1 | Out-Null
  Fail ("服务在 " + $WaitSeconds + " 秒内没有就绪")
}

$state = Invoke-RestMethod -Uri ($apiBase + '/state') -TimeoutSec 30
Write-State ([ordered]@{
  pid = $proc.Id
  port = $Port
  url = $base
  version = $state.version
  home = $HomeDir
  log = $logPath
  startedAt = (Get-Date).ToString('o')
})

Step ("health       = ok (boot " + [int]$sw.Elapsed.TotalMilliseconds + " ms)")
Step ("version      = " + $state.version)
Step ("pi source    = " + $state.resolved.cliSource + " " + $state.resolved.cliVersion)
Step ''
# 不要在这里编造浏览器地址：面板是 DSH 的侧栏 slot，没有独立的 /superpi 网页入口。
# 该实例的 web 根路径由宿主鉴权层保护（无 token 直接 401），而 /api/superpi/* 是免 token 的。
Step ("  api     ->  " + $apiBase)
Step ("  health  ->  " + $apiBase + '/health')
Step ("  home    ->  " + $HomeDir)
Step ("  log     ->  " + $logPath)
Step ''
Step 'how to open the panel:'
Step '  add this profile to your DSH desktop app, then open the superpi entry in the sidebar;'
Step '  or point any DSH client at this instance. The HTTP API above needs no token.'
Step ''
Step ('stop with:  .\tools\start-standalone.bat -Stop')

Write-Output $base

if ($KeepOpen) {
  Step 'keeping the instance in foreground; close this window to stop it'
  try { Wait-Process -Id $proc.Id } finally {
    & taskkill /T /F /PID $proc.Id 2>&1 | Out-Null
    if (Test-Path -LiteralPath $StateFile) { Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue }
  }
}
