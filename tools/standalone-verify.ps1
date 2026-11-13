<#
.SYNOPSIS
  在一个全新的 DSH_HOME 里只装 dsh-pi，验证插件能独立跑起来。

.DESCRIPTION
  这是「可独立在 DSH 中运行」的最强证据：不碰现有 profile，不依赖本机源码目录。
  流程：
    1. 建临时 DSH_HOME（<temp>\dsh-pi-standalone-<6hex>），里面只有 profiles\<name>
    2. profile 的 bundles 只留 @deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app
    3. 用 pnpm 把 dsh-pi 的 tarball 装进去（pi 运行时来自 optionalDependency）
    4. 用 DSH 自己的 Electron Node 启动该 profile 的 web 服务（独立端口）
    5. 走真实 HTTP + 真实 LLM 往返：health / state / create / get_state / prompt / snapshot / delete
    6. 关掉服务；除 -Keep 外删除临时目录

.PARAMETER Port
  standalone 实例监听端口，默认 5599。

.PARAMETER Keep
  保留临时 DSH_HOME，便于人工排查。

.PARAMETER PnpmPath
  pnpm 的 pnpm.cjs 路径。默认取 DSH 自带那份（PATH 上的 pnpm.ps1 是 corepack shim，会失败）。
#>
[CmdletBinding()]
param(
  [int]$Port = 5599,
  [switch]$Keep,
  [string]$PnpmPath = '',
  [string]$PluginRoot = (Split-Path -Parent $PSScriptRoot),
  [int]$WaitSeconds = 120,
  [string]$DshExe = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Step([string]$text) { Write-Output ("[standalone] " + $text) }
function Fail([string]$text) { Write-Output ("[standalone] FAILED: " + $text); exit 2 }

function Resolve-DshExe([string]$explicit) {
  if ($explicit -ne '') {
    if (-not (Test-Path -LiteralPath $explicit)) { throw "DeepSeek Runtime 不存在：$explicit" }
    return $explicit
  }
  $proc = Get-Process -Name 'DeepSeek*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and (Test-Path -LiteralPath $_.Path) } | Select-Object -First 1
  if ($proc) { return $proc.Path }
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
# app.asar 在 OS 视角是单个文件，内部路径 Test-Path 恒为 false；只校验 asar 本体存在，内部路径交给 Electron 解析。
if (-not (Test-Path -LiteralPath $asar)) { Fail "app.asar not found: $asar" }
$cli = Join-Path $asar 'dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$pnpm = Resolve-Pnpm $PnpmPath
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail 'node.exe 未找到' }

Step "dsh exe   = $dshExePath"
Step "desktop   = $cli"
Step "pnpm      = $pnpm"

Push-Location -LiteralPath $PluginRoot
try {
  $pkg = Get-Content -LiteralPath (Join-Path $PluginRoot 'package.json') -Raw | ConvertFrom-Json
  $version = $pkg.version
  $tgz = Join-Path $PluginRoot ('dsh-pi-' + $version + '.tgz')
  if (-not (Test-Path -LiteralPath $tgz)) {
    Step "packing dsh-pi $version"
    if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = 'http://127.0.0.1:10808' }
    if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = 'http://127.0.0.1:10808' }
    & npm pack --silent | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'npm pack 失败' }
  }
  if (-not (Test-Path -LiteralPath $tgz)) { Fail "tarball 缺失：$tgz" }
  Step ("tarball   = " + $tgz + " (" + (Get-Item -LiteralPath $tgz).Length + " B)")

  $suffix = -join ((1..6) | ForEach-Object { '0123456789abcdef'[(Get-Random -Max 16)] })
  $homeDir = Join-Path $env:TEMP ("dsh-pi-standalone-" + $suffix)
  $profileName = 'pi-standalone'
  $profileDir = Join-Path $homeDir ("profiles\" + $profileName)
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  Step "dsh home  = $homeDir"

  $manifest = [ordered]@{
    name = "dsh-profile-$profileName"
    private = $true
    dependencies = [ordered]@{}
    dsh = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') } }
  }
  Set-Content -LiteralPath (Join-Path $profileDir 'package.json') -Value ($manifest | ConvertTo-Json -Depth 8) -Encoding utf8
  $rootLines = @(
    '# dsh profile root - an empty entry list patched over by the layers above.',
    '[]',
    ''
  )
  Set-Content -LiteralPath (Join-Path $profileDir 'cordis.yml') -Value ($rootLines -join [Environment]::NewLine) -Encoding utf8
  $workspaceLines = @(
    'packages:',
    '  - .',
    '',
    'nodeLinker: hoisted',
    'autoInstallPeers: false',
    ''
  )
  Set-Content -LiteralPath (Join-Path $profileDir 'pnpm-workspace.yaml') -Value ($workspaceLines -join [Environment]::NewLine) -Encoding utf8
  $patchLines = @(
    '# dsh-pi standalone verification: the only third-party plugin in this profile',
    '- insert:',
    '    - id: dsh-pi',
    '      name: dsh-pi',
    '      config: {}',
    ''
  )
  Set-Content -LiteralPath (Join-Path $profileDir 'cordis.patch.yml') -Value ($patchLines -join [Environment]::NewLine) -Encoding utf8

  Step 'installing dsh-pi with pnpm'
  $spec = 'file:' + ($tgz -replace '\\', '/')
  Push-Location -LiteralPath $profileDir
  try {
    & $node $pnpm add $spec --ignore-scripts --config.auto-install-peers=false --config.minimum-release-age=0 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'pnpm add 失败' }
  } finally { Pop-Location }

  $installedIndex = Join-Path $profileDir 'node_modules\dsh-pi\index.js'
  $piCli = Join-Path $profileDir 'node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js'
  if (-not (Test-Path -LiteralPath $installedIndex)) { Fail '安装后找不到 dsh-pi/index.js' }
  if (-not (Test-Path -LiteralPath $piCli)) { Fail '安装后找不到 @earendil-works/pi-coding-agent' }
  Step 'installed dsh-pi + pi runtime'

  $logPath = Join-Path $homeDir 'standalone.log'
  $env:ELECTRON_RUN_AS_NODE = '1'
  $env:DSH_HOME = $homeDir
  Step "booting profile $profileName on port $Port"
  # 注意：-ArgumentList 传数组时 PowerShell 会把每个元素裸拼，遇到带空格的路径就断；必须自己加引号拼成一个字符串。
  $bootArgs = '"' + $cli + '" ' + $profileName + ' --port ' + $Port + ' --no-open'
  $proc = Start-Process -FilePath $dshExePath -ArgumentList $bootArgs -PassThru -RedirectStandardOutput $logPath -RedirectStandardError ($logPath + '.err')
  Step ("pid       = " + $proc.Id)

  $base = "http://127.0.0.1:$Port/api/dsh-pi"
  $ready = $false
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $WaitSeconds) {
    try {
      $h = Invoke-RestMethod -Uri ($base + '/health') -TimeoutSec 5
      if ($h.ok) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 800 }
  }
  if (-not $ready) {
    if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Tail 20 }
    if (Test-Path -LiteralPath ($logPath + '.err')) { Get-Content -LiteralPath ($logPath + '.err') -Tail 20 }
    & taskkill /T /F /PID $proc.Id 2>&1 | Out-Null
    Fail "服务在 $WaitSeconds 秒内没有就绪"
  }
  Step ("health    = ok (boot " + [int]$sw.Elapsed.TotalMilliseconds + " ms)")

  $state = Invoke-RestMethod -Uri ($base + '/state') -TimeoutSec 30
  $plugVersion = (Get-Content -LiteralPath (Join-Path $profileDir 'node_modules\dsh-pi\package.json') -Raw | ConvertFrom-Json).version
  Step ("plugin    = " + $state.version + " (installed " + $plugVersion + ")")
  Step ("pi source = " + $state.resolved.cliSource + " " + $state.resolved.cliVersion)
  Step ("pi cli    = " + $state.resolved.cliPath)

  $created = Invoke-RestMethod -Uri ($base + '/sessions') -Method Post -ContentType 'application/json' -Body '{"args":["--no-session"]}' -TimeoutSec 60
  $id = $created.session.id
  if (-not $id) { & taskkill /T /F /PID $proc.Id 2>&1 | Out-Null; Fail '创建会话失败' }
  Step ("session   = " + $id + " pid=" + $created.session.pid)

  $gs = Invoke-RestMethod -Uri ($base + "/sessions/$id/command") -Method Post -ContentType 'application/json' -Body '{"type":"get_state"}' -TimeoutSec 60
  Step ("model     = " + $gs.data.model.id + " / " + $gs.data.model.provider)

  $pr = Invoke-RestMethod -Uri ($base + "/sessions/$id/command") -Method Post -ContentType 'application/json' -Body '{"type":"prompt","message":"只说两个字：独立"}' -TimeoutSec 60
  Step ("prompt    = " + $pr.data.disposition)

  $sw2 = [Diagnostics.Stopwatch]::StartNew()
  $assistantText = ''
  $settled = $false
  while ($sw2.Elapsed.TotalSeconds -lt 120) {
    $snap = Invoke-RestMethod -Uri ($base + "/sessions/$id/snapshot?since=0") -TimeoutSec 30
    foreach ($e in $snap.events) {
      if ($e.record.type -eq 'turn_end') {
        foreach ($part in $e.record.message.content) { if ($part.type -eq 'text') { $assistantText += $part.text } }
      }
      if ($e.record.type -eq 'agent_settled') { $settled = $true }
    }
    if ($settled) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $settled) { & taskkill /T /F /PID $proc.Id 2>&1 | Out-Null; Fail 'LLM 往返未在 120 秒内完成' }
  Step ("assistant = '" + $assistantText + "' (" + [int]$sw2.Elapsed.TotalMilliseconds + " ms)")

  Invoke-WebRequest -Uri ($base + "/sessions/$id") -Method Delete -UseBasicParsing -TimeoutSec 30 | Out-Null
  Step 'session deleted'

  & taskkill /T /F /PID $proc.Id 2>&1 | Out-Null
  Step 'standalone instance stopped'

  if (-not $Keep) {
    Remove-Item -LiteralPath $homeDir -Recurse -Force -ErrorAction SilentlyContinue
    Step 'temp DSH_HOME removed (use -Keep to keep it)'
  } else {
    Step "temp DSH_HOME kept: $homeDir"
  }

  if ($assistantText.Trim() -eq '') { Fail '助手回复为空' }
  Step 'PASS - dsh-pi runs standalone in a fresh DSH_HOME'
  exit 0
} finally {
  Pop-Location
}
