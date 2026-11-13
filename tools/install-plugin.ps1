<#
.SYNOPSIS
  把 dsh-pi 作为真正的 pnpm 依赖装进某个 DSH profile，并生成回滚脚本。

.DESCRIPTION
  每步失败即停，不留半成品。关键是「用包管理器安装」，而不是手工往
  node_modules 里塞副本再手改 manifest —— 那样会让 package.json 与
  pnpm-lock.yaml 漂移，插件管理器下一次跑 pnpm 就会把副本清掉。

    1. npm pack 出 tarball
    2. 装到临时目录，用装出来的那份跑一轮真实 LLM 往返（证明产物可用）
    3. tarball 收进 <profile>\.dsh-local-packages\（profile 自带，不依赖源码仓库还在）
    4. 备份 profile\package.json 与 profile\pnpm-lock.yaml，记录现有 node_modules\dsh-pi 形态
    5. 用 DSH 自带的 pnpm 执行 add file:<tarball> —— manifest / lock / node_modules 三者
       由 pnpm 一次性写一致，pi 运行时（optionalDependencies @earendil-works/*）随之落入
    6. 校验：manifest 依赖串、lock 条目、node_modules\dsh-pi\index.js、pi CLI、再跑一遍真机冒烟
    7. 生成 rollback-<时间戳>.ps1（恢复 package.json + pnpm-lock.yaml，再让 pnpm 收敛 node_modules）

.EXAMPLE
  pwsh -NoProfile -File .\tools\install-plugin.ps1
  pwsh -NoProfile -File .\tools\install-plugin.ps1 -Profile web -SkipVerify
#>
param(
  [string]$Profile = 'desktop',
  [string]$ProfileRoot = (Join-Path $env:USERPROFILE '.dsh\profiles'),
  [string]$PnpmPath = '',
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$profileDir = Join-Path $ProfileRoot $Profile
$profilePkg = Join-Path $profileDir 'package.json'
$profileModules = Join-Path $profileDir 'node_modules'
$profileLock = Join-Path $profileDir 'pnpm-lock.yaml'

function Step([string]$text) { Write-Output ''; Write-Output "=== $text ===" }

# 暂存目录一旦建出来就必须在每条退出路径上清掉 —— 0.3.0 / 0.3.1 两次逐字节比对失败各在
# %TEMP% 下留了一棵约 1.7 万文件的 dsh-pi-stage-*。
#   · 正常结束：末尾显式调用 Remove-StageDir
#   · Fail 路径：Fail 先清理再 exit（exit 不触发 trap，所以必须显式调）
#   · 意外抛错 / Ctrl-C：trap 兜底，清理后 break 终止脚本
$script:stageDir = $null
function Remove-StageDir {
  if ($script:stageDir -and (Test-Path -LiteralPath $script:stageDir)) {
    Remove-Item -LiteralPath $script:stageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  $script:stageDir = $null
}
function Fail([string]$text) { Remove-StageDir; Write-Error $text; exit 1 }
trap { Remove-StageDir; break }

if (-not (Test-Path $profilePkg)) { Fail "找不到 profile：$profilePkg（先确认 DSH 装过并至少启动过一次）" }
if (-not (Test-Path $profileModules)) { Fail "找不到 node_modules：$profileModules" }

# ── 0. 找 pnpm ─────────────────────────────────────────────
# 宿主用的是自己那份 pnpm；PATH 上的 pnpm.ps1 往往是 corepack shim，直接调用会 MODULE_NOT_FOUND。
$pnpmCandidates = @()
if ($PnpmPath -ne '') { $pnpmCandidates += $PnpmPath }
$pnpmCandidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs')
$pnpmCli = $null
foreach ($candidate in $pnpmCandidates) {
  if (Test-Path -LiteralPath $candidate) { $pnpmCli = $candidate; break }
}
if ($null -eq $pnpmCli) {
  Fail 'Cannot find pnpm.cjs. Pass it with -PnpmPath, e.g. -PnpmPath "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs". Do not use pnpm.ps1 from PATH (corepack shim).'
}
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { Fail 'Cannot find node in PATH.' }
Write-Output "pnpm = $pnpmCli"
Write-Output "node = $nodeExe"

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ── 1. pack ────────────────────────────────────────────────
Step 'npm pack'
Push-Location $pluginRoot
Get-ChildItem -Path $pluginRoot -Filter '*.tgz' | Remove-Item -Force
$packRaw = npm pack --json 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm pack failed: $packRaw" }
$packInfo = $packRaw | ConvertFrom-Json
$tgzName = $packInfo[0].filename
$tgzPath = Join-Path $pluginRoot $tgzName
Write-Output ("tarball = {0}  size = {1}  files = {2}" -f $tgzName, $packInfo[0].size, $packInfo[0].entryCount)
Pop-Location

# ── 2. 暂存安装 + 真机验证 ─────────────────────────────────
Step 'staging install into TEMP'
$stage = Join-Path $env:TEMP ('dsh-pi-stage-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Path $stage | Out-Null
$script:stageDir = $stage
Push-Location $stage
'{ "name": "dsh-pi-stage", "private": true, "type": "module" }' | Set-Content -Path package.json -Encoding utf8
$stageRaw = npm install $tgzPath --no-audit --no-fund --loglevel=error 2>&1 | Out-String
$installExit = $LASTEXITCODE
Pop-Location
if ($installExit -ne 0) { Fail ("npm install failed (exit=$installExit): " + $stageRaw) }
foreach ($line in ($stageRaw.Trim() -split '\r?\n' | Select-Object -Last 3)) { Write-Output $line }

$stagedPlugin = Join-Path $stage 'node_modules\dsh-pi'
$stagedPiScope = Join-Path $stage 'node_modules\@earendil-works'
if (-not (Test-Path (Join-Path $stagedPlugin 'index.js'))) { Fail 'staging dir has no dsh-pi\index.js' }
$hasPi = Test-Path (Join-Path $stagedPiScope 'pi-coding-agent\package.json')
Write-Output "staged dsh-pi = $stagedPlugin"
Write-Output "staged pi     = $hasPi"
if ($hasPi) {
  $stagedCli = Join-Path $stagedPiScope 'pi-coding-agent\dist\bundle\cli.js'
  $stagedVer = (& $nodeExe $stagedCli --version 2>&1 | Out-String).Trim()
  Write-Output "staged pi cli = $stagedVer"
}

if (-not $SkipVerify) {
  Step 'verify packed artifact against a real LLM'
  Push-Location $pluginRoot
  node (Join-Path $pluginRoot 'test\packed-smoke.mjs') (Join-Path $stagedPlugin 'index.js') 2>&1 | Select-Object -Last 24
  $smokeExit = $LASTEXITCODE
  Pop-Location
  if ($smokeExit -ne 0) { Fail "packed smoke failed (exit=$smokeExit); profile untouched" }
  Write-Output 'smokeExit=0'
} else {
  Write-Output 'skipped real-LLM verification (-SkipVerify)'
}

# ── 3. tarball 收进 profile ────────────────────────────────
Step 'copy tarball into profile'
$localPkgDir = Join-Path $profileDir '.dsh-local-packages'
New-Item -ItemType Directory -Path $localPkgDir -Force | Out-Null
$profileTgz = Join-Path $localPkgDir $tgzName
Copy-Item -LiteralPath $tgzPath -Destination $profileTgz -Force
$depSpec = 'file:' + $profileTgz
Write-Output "dep spec = $depSpec"

# ── 4. 备份现状 ────────────────────────────────────────────
Step 'backup current state'
$backupDir = Join-Path (Join-Path $profileDir '.backup') ('dsh-pi-' + $stamp)
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item -LiteralPath $profilePkg -Destination (Join-Path $backupDir 'package.json') -Force
$hadLock = Test-Path $profileLock
if ($hadLock) { Copy-Item -LiteralPath $profileLock -Destination (Join-Path $backupDir 'pnpm-lock.yaml') -Force }

$pluginDir = Join-Path $profileModules 'dsh-pi'
$prior = [ordered]@{
  stamp = $stamp
  profile = $Profile
  profileDir = $profileDir
  existed = $false
  kind = 'none'
  junctionTarget = $null
  hadLock = $hadLock
  addedPiPackages = @()
  backupDir = $backupDir
  tgzInProfile = $profileTgz
}
if (Test-Path $pluginDir) {
  $item = Get-Item -LiteralPath $pluginDir -Force
  $prior.existed = $true
  if ($null -ne $item.LinkType) {
    $prior.kind = 'junction'
    $prior.junctionTarget = @($item.Target)[0]
    Write-Output "existing dsh-pi is a link -> $($prior.junctionTarget) (recorded only)"
  } else {
    $prior.kind = 'dir'
    $copyTo = Join-Path $backupDir 'node_modules-dsh-pi'
    Write-Output "existing dsh-pi is a real dir; copied to $copyTo"
    Copy-Item -LiteralPath $pluginDir -Destination $copyTo -Recurse -Force
  }
}
$prior | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $backupDir 'prior-state.json') -Encoding utf8
Write-Output "backup = $backupDir"

# ── 5. 交给 pnpm 安装 ──────────────────────────────────────
Step 'pnpm add (manifest + lock + node_modules in one step)'
Push-Location $profileDir
$addRaw = & $nodeExe $pnpmCli add $depSpec --ignore-scripts --config.auto-install-peers=false --config.minimum-release-age=0 2>&1 | Out-String
$addExit = $LASTEXITCODE
Pop-Location
foreach ($line in ($addRaw.Trim() -split '\r?\n' | Select-Object -Last 16)) { Write-Output $line }
if ($addExit -ne 0) { Fail ("pnpm add failed (exit=$addExit). Rollback: pwsh -File '" + $backupDir + '\rollback-' + $stamp + ".ps1'. Output: " + $addRaw) }

# ── 6. 校验 ────────────────────────────────────────────────
Step 'verify installation'
$failures = New-Object System.Collections.Generic.List[string]

if (-not (Test-Path (Join-Path $pluginDir 'index.js'))) { $failures.Add('node_modules\dsh-pi\index.js missing') }

$pkgAfter = Get-Content -LiteralPath $profilePkg -Raw | ConvertFrom-Json
$depAfter = $pkgAfter.dependencies.'dsh-pi'
if ($null -eq $depAfter) {
  $failures.Add('profile package.json has no dsh-pi dependency')
} elseif (-not $depAfter.StartsWith('file:')) {
  $failures.Add("profile package.json dsh-pi is not a file: spec, got $depAfter")
} else {
  Write-Output "manifest dep = $depAfter"
}

if (-not (Test-Path $profileLock)) {
  $failures.Add('profile pnpm-lock.yaml missing')
} else {
  $lockText = Get-Content -LiteralPath $profileLock -Raw
  # 缩进随 pnpm 版本变化（v11 是 6 空格），只认「整行是 dsh-pi: 键」
  if ($lockText -notmatch '(?m)^\s+dsh-pi:\s*$') { $failures.Add('pnpm-lock.yaml has no dsh-pi entry (lock drift)') }
  if ($lockText -notmatch 'pi-coding-agent') { $failures.Add('pnpm-lock.yaml has no pi-coding-agent (runtime not locked)') }
  Write-Output ('lock = {0} B' -f (Get-Item -LiteralPath $profileLock).Length)
}

$profilePiScope = Join-Path $profileModules '@earendil-works'
$profilePiCli = Join-Path $profilePiScope 'pi-coding-agent\dist\bundle\cli.js'
if (Test-Path $profilePiCli) {
  $profilePiVer = (& $nodeExe $profilePiCli --version 2>&1 | Out-String).Trim()
  Write-Output "profile pi cli = $profilePiVer"
  $prior.addedPiPackages = @(Get-ChildItem -LiteralPath $profilePiScope -Directory | ForEach-Object { $_.Name })
  $prior | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $backupDir 'prior-state.json') -Encoding utf8
} else {
  $failures.Add("$profilePiCli missing (pi runtime not installed in profile)")
}

$modulesYaml = Join-Path $profileModules '.modules.yaml'
if (Test-Path $modulesYaml) {
  $my = Get-Content -LiteralPath $modulesYaml -Raw
  if ($my -notmatch 'dsh-pi') { $failures.Add('node_modules .modules.yaml does not know dsh-pi (next pnpm run would prune it)') }
} else {
  $failures.Add('node_modules .modules.yaml missing')
}

if ($failures.Count -gt 0) {
  foreach ($f in $failures) { Write-Output "FAIL $f" }
  Fail ("install verification failed with " + $failures.Count + " problem(s). Rollback: pwsh -File '" + $backupDir + '\rollback-' + $stamp + ".ps1'")
}
Write-Output 'verified: manifest / lock / node_modules agree'

# 副本必须与刚打出的 tarball 逐字节一致。pnpm 对 file: 依赖按 lock 里的 integrity
# 复用它自己的缓存——版本号没变但内容变了时，它会把旧内容装回来且 exit=0。
# 这种「装成功但装的是旧代码」只能靠内容比对拦住。
Step 'verify installed copy matches the packed artifact'
$contentMismatch = New-Object System.Collections.Generic.List[string]
$tarList = @()
if (Get-Command tar -ErrorAction SilentlyContinue) {
  $tarList = @((tar -tf $tgzPath) | Where-Object { -not $_.EndsWith('/') })
}
foreach ($entry in $tarList) {
  $rel = $entry -replace '^package/', ''
  $srcFile = Join-Path $pluginRoot ($rel -replace '/', '\')
  $dstFile = Join-Path $pluginDir ($rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $dstFile)) { $contentMismatch.Add("$rel missing in installed copy"); continue }
  if (-not (Test-Path -LiteralPath $srcFile)) { continue }
  $h1 = (Get-FileHash -LiteralPath $srcFile -Algorithm SHA256).Hash
  $h2 = (Get-FileHash -LiteralPath $dstFile -Algorithm SHA256).Hash
  if ($h1 -ne $h2) { $contentMismatch.Add($rel) }
}
$installedVersion = (Get-Content -LiteralPath (Join-Path $pluginDir 'package.json') -Raw | ConvertFrom-Json).version
Write-Output "installed version = $installedVersion"
if ($tarList.Count -eq 0) {
  Write-Output 'tar not found: skipped byte comparison (relies on the version bump + pnpm integrity check)'
} else {
  Write-Output ("compared {0} shipped file(s) against the source tree" -f $tarList.Count)
}
if ($contentMismatch.Count -gt 0) {
  foreach ($f in $contentMismatch) { Write-Output "STALE $f" }
  Fail ("installed copy does not match the packed tarball (" + $contentMismatch.Count + " file(s)). pnpm reuses its store by integrity when the version number is unchanged, so bump the version before reinstalling. Rollback: pwsh -File '" + $backupDir + '\rollback-' + $stamp + ".ps1'")
}
if ($tarList.Count -gt 0) { Write-Output 'verified: installed copy is byte-identical to the tarball' }

if (-not $SkipVerify) {
  Step 'verify installed copy against a real LLM'
  Push-Location $pluginRoot
  node (Join-Path $pluginRoot 'test\packed-smoke.mjs') (Join-Path $pluginDir 'index.js') 2>&1 | Select-Object -Last 24
  $smoke2 = $LASTEXITCODE
  Pop-Location
  if ($smoke2 -ne 0) { Fail "profile copy smoke failed (exit=$smoke2)" }
  Write-Output 'smokeExit=0'
}

# ── 7. 回滚脚本 ────────────────────────────────────────────
Step 'generate rollback script'
$rollback = Join-Path $backupDir ('rollback-' + $stamp + '.ps1')
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# Rollback dsh-pi install (' + $stamp + ') - generated by tools\install-plugin.ps1')
$lines.Add('$ErrorActionPreference = ''Stop''')
$lines.Add('$profileDir = ' + "'" + $profileDir + "'")
$lines.Add('$profileModules = Join-Path $profileDir ''node_modules''')
$lines.Add('$pluginDir = Join-Path $profileModules ''dsh-pi''')
$lines.Add('$pnpmCli = ' + "'" + $pnpmCli + "'")
$lines.Add('')
$lines.Add('Copy-Item -LiteralPath (Join-Path $PSScriptRoot ''package.json'') -Destination (Join-Path $profileDir ''package.json'') -Force')
$lines.Add('if (Test-Path (Join-Path $PSScriptRoot ''pnpm-lock.yaml'')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot ''pnpm-lock.yaml'') -Destination (Join-Path $profileDir ''pnpm-lock.yaml'') -Force }')
$lines.Add('Write-Output ''1/3 restored profile package.json and pnpm-lock.yaml''')
$lines.Add('')
$lines.Add('if (Test-Path $pluginDir) { Remove-Item -LiteralPath $pluginDir -Recurse -Force }')
if ($prior.kind -eq 'junction') {
  $lines.Add('New-Item -ItemType Junction -Path $pluginDir -Target ' + "'" + $prior.junctionTarget + "'" + ' | Out-Null')
  $lines.Add('Write-Output ''2/3 restored junction -> ' + $prior.junctionTarget + '''')
} elseif ($prior.kind -eq 'dir') {
  $lines.Add('Copy-Item -LiteralPath (Join-Path $PSScriptRoot ''node_modules-dsh-pi'') -Destination $pluginDir -Recurse -Force')
  $lines.Add('Write-Output ''2/3 restored previous node_modules\dsh-pi directory''')
} else {
  $lines.Add('Write-Output ''2/3 previous state had no dsh-pi, leaving it removed''')
}
$lines.Add('')
foreach ($name in $prior.addedPiPackages) {
  $lines.Add('if (Test-Path (Join-Path $profileModules ''@earendil-works\' + $name + ''')) { Remove-Item -LiteralPath (Join-Path $profileModules ''@earendil-works\' + $name + ''') -Recurse -Force }')
}
$lines.Add('Write-Output ''3/3 removed pi packages brought in by this install: ' + ($prior.addedPiPackages -join ', ') + '''')
$lines.Add('')
$lines.Add('# Let pnpm converge node_modules (and .modules.yaml) to the restored manifest + lock')
$lines.Add('if (Test-Path $pnpmCli) {')
$lines.Add('  Push-Location $profileDir')
$lines.Add('  & node $pnpmCli install --frozen-lockfile --ignore-scripts')
$lines.Add('  $code = $LASTEXITCODE')
$lines.Add('  Pop-Location')
$lines.Add('  Write-Output "pnpm install exit=$code"')
$lines.Add('} else {')
$lines.Add('  Write-Output "pnpm not found at $pnpmCli; run pnpm install --frozen-lockfile in $profileDir manually"')
$lines.Add('}')
$lines.Add('Write-Output ''Rollback done. Restart DSH to take effect.''')
$lines | Set-Content -LiteralPath $rollback -Encoding utf8
Write-Output "rollback = $rollback"

# ── 收尾 ──────────────────────────────────────────────────
Remove-StageDir

Step 'done'
Write-Output "dsh-pi is now a pnpm dependency of profile '$Profile'. Next:"
Write-Output '  1) restart DSH (plugin code is snapshotted at import, a restart is required)'
Write-Output '  2) open the pi panel; if the runtime is missing, click "install pi"'
Write-Output '  3) diagnostics: GET http://127.0.0.1:<port>/api/dsh-pi/diagnostics'
Write-Output "  4) rollback: pwsh -File '$rollback'"
