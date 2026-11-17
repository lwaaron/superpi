<#
.SYNOPSIS
  一键启动：同时起「命令行编程会话窗口」(pi TUI) 与「DSH web 面板实例」。

.DESCRIPTION
  这两个是同一个 pi / 同一个 agent loop 的两个平级前端，形态不同、互不替代：

    1) pi TUI —— 命令行编程会话窗口。必须在**真实控制台**里跑（非 TTY 下 pi 会静默退出），
       所以用 Windows Terminal 新开一个窗口，回落 conhost + cmd。
       这是「我要写代码」的入口。
    2) DSH web —— 浏览器/侧栏面板形态的实例，监听 25117。后台起，不占前台窗口。
       这是「我要看面板 UI」的入口。

  两者并行启动、互不阻塞：任一失败都不影响另一个，最后分别报告状态与失败原因。

  位置无关：pi 与 node 一律走 src/pi-runtime.mjs 的解析链，不硬编码任何本机路径。

.PARAMETER WorkDir
  pi TUI 的工作目录（也就是 agent 干活的项目根）。默认 = 本仓库根。

.PARAMETER Resume
  pi 会话续接方式：auto（默认，--continue）/ pick（--resume 弹列表）/ new（--new）。

.PARAMETER Port
  DSH web 实例端口，默认 25117（与 tools/start-standalone.ps1 一致）。

.PARAMETER NoTui
  只起 web，不开 TUI 窗口。

.PARAMETER NoWeb
  只开 TUI 窗口，不起 web。

.PARAMETER NoEditorExtension
  不装 superpi 的输入框扩展（extensions/superpi-editor.ts）。默认会装：
  它用 pi 官方的 ctx.ui.setEditorComponent 换输入框，补上 Ctrl+A 全选、
  Shift+方向扩选、Ctrl+C 复制不清空、Ctrl+X 剪切、Backspace/Delete 删选区、
  以及 Windows 下「资源管理器复制文件 → Ctrl+V 得到绝对路径」。

.PARAMETER Stop
  停掉由本脚本起的两个实例：web 走 start-standalone 的 -Stop；
  TUI 窗口按 .standalone/tui.json 记录的 pid 关掉（只关自己起的，不动别人）。

.PARAMETER Status
  只报告两者状态，不做任何变更。

.EXAMPLE
  .\一键启动.bat
  .\一键启动.bat -Resume pick
  .\一键启动.bat -WorkDir D:\my_projects\other
  .\一键启动.bat -Status
  .\一键启动.bat -Stop
#>
[CmdletBinding()]
param(
  [string]$WorkDir = '',
  [ValidateSet('auto', 'pick', 'new')]
  [string]$Resume = 'auto',
  [int]$Port = 25117,
  [switch]$NoTui,
  [switch]$NoWeb,
  [switch]$Stop,
  [switch]$Status,
  [switch]$NoEditorExtension,
  [int]$WaitSeconds = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PluginRoot = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $PluginRoot '.standalone'
$TuiStateFile = Join-Path $StateDir 'tui.json'
$WebLauncher = Join-Path $PluginRoot 'tools\start-standalone.ps1'

function Step([string]$t) { Write-Host ('[launch] ' + $t) }
function Ok([string]$t) { Write-Host ('[launch]   OK   ' + $t) -ForegroundColor Green }
function Warn2([string]$t) { Write-Host ('[launch]   WARN ' + $t) -ForegroundColor Yellow }
function Bad([string]$t) { Write-Host ('[launch]   FAIL ' + $t) -ForegroundColor Red }

function Get-ListeningPid([int]$p) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess }
  return 0
}

function Test-WebHealth([int]$p) {
  try { return [bool](Invoke-RestMethod -Uri ('http://127.0.0.1:' + $p + '/api/superpi/health') -TimeoutSec 3).ok }
  catch { return $false }
}

function Read-TuiState {
  if (-not (Test-Path -LiteralPath $TuiStateFile)) { return $null }
  try { return (Get-Content -LiteralPath $TuiStateFile -Raw | ConvertFrom-Json) } catch { return $null }
}

# ── -Status ───────────────────────────────────────────────────────────────
if ($Status) {
  Step 'status'
  $webPid = Get-ListeningPid $Port
  $webOk = Test-WebHealth $Port
  if ($webPid -gt 0 -and $webOk) { Ok ('web  port ' + $Port + ' pid ' + $webPid + ' (health ok)') }
  elseif ($webPid -gt 0) { Warn2 ('web  port ' + $Port + ' pid ' + $webPid + ' (端口被占但不是本插件)') }
  else { Warn2 ('web  port ' + $Port + ' (未启动)') }

  $ts = Read-TuiState
  if ($ts -and $ts.pid) {
    $alive = [bool](Get-Process -Id $ts.pid -ErrorAction SilentlyContinue)
    if ($alive) { Ok ('tui  pid ' + $ts.pid + ' cwd ' + $ts.workdir) }
    else { Warn2 ('tui  记录的 pid ' + $ts.pid + ' 已退出') }
  } else { Warn2 'tui  未启动过（or 记录已清）' }
  exit 0
}

# ── -Stop ─────────────────────────────────────────────────────────────────
if ($Stop) {
  Step 'stopping'
  # web：交给它自己的启动器（它记得 pid 与端口）
  if (Test-Path -LiteralPath $WebLauncher) {
    $psHost = (Get-Command pwsh -ErrorAction SilentlyContinue)
    $psExe = if ($psHost) { $psHost.Source } else { Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
    & $psExe -NoProfile -ExecutionPolicy Bypass -File $WebLauncher -Stop -Port $Port 2>&1 | ForEach-Object { '         ' + $_ }
  }
  # tui：只关我们自己记录的那个进程
  $ts = Read-TuiState
  if ($ts -and $ts.pid) {
    $p = Get-Process -Id $ts.pid -ErrorAction SilentlyContinue
    if ($p) {
      & taskkill /T /F /PID $ts.pid 2>&1 | Out-Null
      Step ('stopped tui pid ' + $ts.pid)
    } else { Step ('tui pid ' + $ts.pid + ' already gone') }
    Remove-Item -LiteralPath $TuiStateFile -Force -ErrorAction SilentlyContinue
  } else { Step 'no tui recorded' }
  exit 0
}

# ── 解析 pi 与 node（走仓库自己的解析链，禁止硬编码）──────────────────────
$piResolved = $null
$nodePath = ''
try {
  # 探针脚本落在 %TEMP%，所以 import 必须用**绝对 file:// URL**，
  # 不能写相对路径（那会相对 %TEMP% 解析，找不到 src/pi-runtime.mjs）。
  $runtimeModule = Join-Path $PluginRoot 'src\pi-runtime.mjs'
  if (-not (Test-Path -LiteralPath $runtimeModule)) {
    throw ('找不到运行时解析模块：' + $runtimeModule)
  }
  $moduleUrl = ([System.Uri]$runtimeModule).AbsoluteUri
  $probe = @"
import { resolvePiRuntime, resolveNodeRuntime } from '$moduleUrl'
const root = process.argv[2]
const pi = resolvePiRuntime({ pluginRoot: root })
const node = resolveNodeRuntime({ pluginRoot: root })
process.stdout.write(JSON.stringify({ pi, node }))
"@
  $tmp = Join-Path $env:TEMP ('superpi-launch-probe-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.mjs')
  Set-Content -LiteralPath $tmp -Value $probe -Encoding utf8
  try {
    $raw = & node $tmp $PluginRoot 2>&1
    if ($LASTEXITCODE -ne 0) { throw ("解析链执行失败：" + ($raw -join ' ')) }
    $parsed = ($raw -join '') | ConvertFrom-Json
    $piResolved = $parsed.pi
    $nodePath = [string]$parsed.node.path
  } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
} catch {
  Warn2 ('pi 运行时解析失败：' + $_.Exception.Message)
}

if ($piResolved -and $piResolved.cliPath) {
  Step ('pi   ' + $piResolved.cliPath + ' (' + $piResolved.source + ' ' + $piResolved.version + ')')
} elseif (-not $NoTui) {
  Bad 'pi 运行时未找到 —— TUI 无法启动。先跑 npm run test:fresh 或装一次运行时。'
}
if ($nodePath -ne '') { Step ('node ' + $nodePath) }

if ($WorkDir -eq '') { $WorkDir = $PluginRoot }
if (-not (Test-Path -LiteralPath $WorkDir)) {
  Warn2 ('工作目录不存在，将创建：' + $WorkDir)
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
}
$WorkDir = (Resolve-Path -LiteralPath $WorkDir).Path

$results = [ordered]@{ tui = 'skipped'; web = 'skipped' }
$reasons = @{ tui = ''; web = '' }

# ── 1. 起 pi TUI（真实控制台窗口）────────────────────────────────────────
if ($NoTui) {
  # 明确跳过：保持 'skipped'，但原因写清楚，不要让 summary 误报成别的。
  $reasons['tui'] = '-NoTui'
} elseif (-not $piResolved -or -not $piResolved.cliPath) {
  # 想启动但运行时不可用 —— 这是**失败**，不是跳过。必须如实报。
  $results.tui = 'failed'
  if ($reasons['tui'] -eq '') { $reasons['tui'] = 'pi 运行时未解析出来' }
} else {
  Step ('starting pi TUI in a new console, cwd = ' + $WorkDir)

  # 先把 superpi 的输入框扩展装进 pi（官方扩展，不改 pi 任何文件）。
  # 装在 <piAgentDir>/extensions/，pi 启动时自动加载；失败不阻断 TUI 启动 ——
  # 扩展只影响输入框的复制/剪切/文件粘贴，pi 本体照跑。
  if (-not $NoEditorExtension) {
    $extScript = Join-Path $PluginRoot 'tools\install-pi-extension.mjs'
    if (Test-Path -LiteralPath $extScript) {
      try {
        $nodeExe = 'node'
        if ($nodePath -ne '') { $nodeExe = $nodePath }
        $null = & $nodeExe $extScript --install 2>&1
        Ok 'input-box extension installed (Ctrl+A/Shift-select/Ctrl+C/X/file paste)'
      } catch {
        Warn2 ('input-box extension not installed: ' + $_.Exception.Message)
      }
    }
  }
  $respArg = switch ($Resume) {
    'pick' { '--resume' }
    'new' { '--new' }
    default { '--continue' }
  }
  # pi 需要真实 TTY（实测非 TTY 下直接静默退出），所以必须开一个真实控制台窗口。
  # wt 优先（pi 的全屏界面在新版终端才稳），没有 wt 就 start + conhost。
  $wt = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'
  $haveWt = (Test-Path -LiteralPath $wt)
  if (-not $haveWt) { $haveWt = [bool](Get-Command wt.exe -ErrorAction SilentlyContinue) }

  # 记录启动前的 pi 进程集合，之后用差集找到新起的那个（wt/start 都是异步开窗，拿不到 pid）。
  $before = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $piResolved.cliPath + '*') } |
    Select-Object -ExpandProperty ProcessId)

  # 拼一条 cmd 命令行（node + cli + resume 参数），交给新窗口执行。
  $cmdLine = '"' + $nodePath + '" "' + $piResolved.cliPath + '" ' + $respArg

  try {
    if ($haveWt) {
      $wtExe = if (Test-Path -LiteralPath $wt) { $wt } else { (Get-Command wt.exe).Source }
      # wt 的引号规则会吃掉参数：用 cmd /c 包一层，并自己把整条命令括起来。
      Start-Process -FilePath $wtExe -ArgumentList @('-d', $WorkDir, 'cmd', '/c', ($cmdLine + '')) | Out-Null
      $launcher = 'wt'
    } else {
      # start 的第一个引号参数是窗口标题（必须给空串），工作目录用 /D。
      Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', 'start', '""', '/D', $WorkDir, 'cmd', '/c', $cmdLine) | Out-Null
      $launcher = 'console'
    }

    # 等新进程出现（最多 15 秒），记下 pid 供 -Stop 用。
    $newPid = 0
    $swTui = [Diagnostics.Stopwatch]::StartNew()
    while ($swTui.Elapsed.TotalSeconds -lt 15) {
      $now = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $piResolved.cliPath + '*') } |
        Select-Object -ExpandProperty ProcessId)
      $diff = @($now | Where-Object { $before -notcontains $_ })
      if ($diff.Count -gt 0) { $newPid = [int]$diff[0]; break }
      Start-Sleep -Milliseconds 500
    }

    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    [ordered]@{
      pid = $newPid
      launcher = $launcher
      workdir = $WorkDir
      resume = $respArg
      cliPath = $piResolved.cliPath
      startedAt = (Get-Date).ToString('o')
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $TuiStateFile -Encoding utf8

    if ($newPid -gt 0) { $results.tui = 'launched (' + $launcher + ', pid ' + $newPid + ', ' + $respArg + ')' }
    else { $results.tui = 'launched (' + $launcher + ', pid unknown, ' + $respArg + ')' }
  } catch {
    $results.tui = 'failed'
    $reasons['tui'] = $_.Exception.Message
  }
}

# ── 2. 起 DSH web（后台，不占前台窗口）───────────────────────────────────
if ($NoWeb) {
  $reasons['web'] = '-NoWeb'
} else {
  Step ('starting DSH web on port ' + $Port)
  if (-not (Test-Path -LiteralPath $WebLauncher)) {
    $results.web = 'failed'
    $reasons['web'] = ('缺少 ' + $WebLauncher)
  } else {
    $webLog = Join-Path $StateDir 'logs'
    New-Item -ItemType Directory -Force -Path $webLog | Out-Null
    $bootLog = Join-Path $webLog ('launch-web-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
    try {
      # $args 是 PowerShell 自动变量，不能覆盖；用 $psArgs。
      $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $WebLauncher, '-Port', $Port, '-WaitSeconds', $WaitSeconds)
      # pwsh 不一定存在（只有 5.1 的机器）；回落 Windows PowerShell。
      $psHost = (Get-Command pwsh -ErrorAction SilentlyContinue)
      $psExe = if ($psHost) { $psHost.Source } else { Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
      $p = Start-Process -FilePath $psExe -ArgumentList $psArgs -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $bootLog -RedirectStandardError ($bootLog + '.err')
      # 等它就绪（最多 WaitSeconds，脚本内部也会等，这里只做外层兜底观察）
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $ready = $false
      while ($sw.Elapsed.TotalSeconds -lt $WaitSeconds) {
        if (Test-WebHealth $Port) { $ready = $true; break }
        if ($p.HasExited) { break }
        Start-Sleep -Milliseconds 700
      }
      if ($ready) { $results.web = ('ready pid ' + (Get-ListeningPid $Port)) }
      else {
        $results.web = 'failed'
        $tail = ''
        if (Test-Path -LiteralPath $bootLog) { $tail = (Get-Content -LiteralPath $bootLog -Tail 6) -join ' | ' }
        $reasons['web'] = ('未就绪（日志 ' + $bootLog + '）：' + $tail)
      }
    } catch {
      $results.web = 'failed'
      $reasons['web'] = $_.Exception.Message
    }
  }
}

# ── 汇总 ─────────────────────────────────────────────────────────────────
Step 'summary'
if ($results.tui -like 'launched*') { Ok ('tui  ' + $results.tui) }
elseif ($results.tui -eq 'skipped') { Warn2 ('tui  skipped (' + $reasons['tui'] + ')') }
else { Bad ('tui  ' + $results.tui + ' :: ' + $reasons['tui']) }

if ($results.web -like 'ready*') { Ok ('web  ' + $results.web + '  -> http://127.0.0.1:' + $Port + '/api/superpi') }
elseif ($results.web -eq 'skipped') { Warn2 ('web  skipped (' + $reasons['web'] + ')') }
else { Bad ('web  ' + $results.web + ' :: ' + $reasons['web']) }

Step ''
Step 'the TUI window is a separate console; close it to end the coding session.'
Step ('stop the web instance: .\一键启动.bat -Stop')

# 两个都失败才算失败；一个成功就 exit 0（并行启动，互不阻塞）
if ($results.tui -eq 'failed' -and $results.web -eq 'failed') { exit 2 }
exit 0
