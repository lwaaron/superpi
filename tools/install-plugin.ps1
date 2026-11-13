<#
.SYNOPSIS
  把 dsh-pi 作为真正的依赖装进某个 DSH profile，并生成回滚脚本。

.DESCRIPTION
  每步失败即停，不留半成品：
    1. npm pack 出 tarball
    2. 装到临时目录，用装出来的那份跑一轮真实 LLM 往返（证明产物可用）
    3. tarball 收进 <profile>\.dsh-local-packages\（profile 自带，不依赖源码仓库还在）
    4. 备份 profile\package.json 与现有 node_modules\dsh-pi（junction 只记指向，不复制内容）
    5. 用暂存目录里已解析好的副本替换 node_modules\dsh-pi，并补齐 @earendil-works\*
    6. 把 package.json 的依赖改写成 file:<tarball>，让以后的 install 可复现
    7. 生成 rollback-<时间戳>.ps1

.EXAMPLE
  pwsh -NoProfile -File .\tools\install-plugin.ps1
  pwsh -NoProfile -File .\tools\install-plugin.ps1 -Profile web -SkipVerify
#>
param(
  [string]$Profile = 'desktop',
  [string]$ProfileRoot = (Join-Path $env:USERPROFILE '.dsh\profiles'),
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$profileDir = Join-Path $ProfileRoot $Profile
$profilePkg = Join-Path $profileDir 'package.json'
$profileModules = Join-Path $profileDir 'node_modules'

function Step([string]$text) { Write-Output ''; Write-Output "=== $text ===" }
function Fail([string]$text) { Write-Error $text; exit 1 }

if (-not (Test-Path $profilePkg)) { Fail "找不到 profile：$profilePkg（先确认 DSH 装过并至少启动过一次）" }
if (-not (Test-Path $profileModules)) { Fail "找不到 node_modules：$profileModules" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ── 1. pack ────────────────────────────────────────────────
Step 'npm pack'
Push-Location $pluginRoot
Get-ChildItem -Path $pluginRoot -Filter '*.tgz' | Remove-Item -Force
$packRaw = npm pack --json 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm pack 失败：$packRaw" }
$packInfo = $packRaw | ConvertFrom-Json
$tgzName = $packInfo[0].filename
$tgzPath = Join-Path $pluginRoot $tgzName
Write-Output ("tarball = {0}  size = {1}  files = {2}" -f $tgzName, $packInfo[0].size, $packInfo[0].entryCount)
Pop-Location

# ── 2. 暂存安装 + 真机验证 ──────────────────────────────────
Step '暂存安装到 TEMP'
$stage = Join-Path $env:TEMP ('dsh-pi-stage-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Path $stage | Out-Null
Push-Location $stage
'{ "name": "dsh-pi-stage", "private": true, "type": "module" }' | Set-Content -Path package.json -Encoding utf8
npm install $tgzPath --no-audit --no-fund --loglevel=error 2>&1 | Select-Object -Last 3
$installExit = $LASTEXITCODE
Pop-Location
if ($installExit -ne 0) { Fail "npm install 失败（exit=$installExit）" }

$stagedPlugin = Join-Path $stage 'node_modules\dsh-pi'
$stagedPiScope = Join-Path $stage 'node_modules\@earendil-works'
if (-not (Test-Path (Join-Path $stagedPlugin 'index.js'))) { Fail '暂存目录里没有 dsh-pi\index.js' }
$hasPi = Test-Path (Join-Path $stagedPiScope 'pi-coding-agent\package.json')
Write-Output "staged dsh-pi = $stagedPlugin"
Write-Output "staged pi     = $hasPi"

if (-not $SkipVerify) {
  Step '打包产物真机验证（真跑一轮 LLM）'
  Push-Location $pluginRoot
  node (Join-Path $pluginRoot 'test\packed-smoke.mjs') (Join-Path $stagedPlugin 'index.js') 2>&1 | Select-Object -Last 24
  $smokeExit = $LASTEXITCODE
  Pop-Location
  if ($smokeExit -ne 0) { Fail "打包产物冒烟失败（exit=$smokeExit），profile 未改动" }
  Write-Output 'smokeExit=0'
} else {
  Write-Output '已跳过真机验证（-SkipVerify）'
}

# ── 3. tarball 收进 profile ────────────────────────────────
Step 'tarball 收进 profile'
$localPkgDir = Join-Path $profileDir '.dsh-local-packages'
New-Item -ItemType Directory -Path $localPkgDir -Force | Out-Null
$profileTgz = Join-Path $localPkgDir $tgzName
Copy-Item -LiteralPath $tgzPath -Destination $profileTgz -Force
$depSpec = 'file:' + ($profileTgz -replace '\\', '/')
Write-Output "dep spec = $depSpec"

# ── 4. 备份现状 ────────────────────────────────────────────
Step '备份现状'
$backupDir = Join-Path (Join-Path $profileDir '.backup') ('dsh-pi-' + $stamp)
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item -LiteralPath $profilePkg -Destination (Join-Path $backupDir 'package.json') -Force

$pluginDir = Join-Path $profileModules 'dsh-pi'
$prior = [ordered]@{
  stamp = $stamp
  profile = $Profile
  profileDir = $profileDir
  existed = $false
  kind = 'none'
  junctionTarget = $null
  hadPiScope = $hasPi
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
    Write-Output "现有 dsh-pi 是链接，指向 $($prior.junctionTarget)（只记指向，不复制）"
    Remove-Item -LiteralPath $pluginDir -Force
  } else {
    $prior.kind = 'dir'
    $copyTo = Join-Path $backupDir 'node_modules-dsh-pi'
    Write-Output "现有 dsh-pi 是实体目录，整份备份到 $copyTo"
    Copy-Item -LiteralPath $pluginDir -Destination $copyTo -Recurse -Force
    Remove-Item -LiteralPath $pluginDir -Recurse -Force
  }
}
$prior | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $backupDir 'prior-state.json') -Encoding utf8
Write-Output "backup = $backupDir"

# ── 5. 落地副本 ────────────────────────────────────────────
Step '安装插件副本'
Copy-Item -LiteralPath $stagedPlugin -Destination $pluginDir -Recurse -Force
Write-Output "已放入 $pluginDir"

$profilePiScope = Join-Path $profileModules '@earendil-works'
$addedPi = @()
if ($hasPi) {
  if (-not (Test-Path $profilePiScope)) { New-Item -ItemType Directory -Path $profilePiScope | Out-Null }
  foreach ($pkg in Get-ChildItem -LiteralPath $stagedPiScope -Directory) {
    $dest = Join-Path $profilePiScope $pkg.Name
    if (Test-Path $dest) { Write-Output "已有 $($pkg.Name)，跳过"; continue }
    Copy-Item -LiteralPath $pkg.FullName -Destination $dest -Recurse -Force
    $addedPi += $pkg.Name
    Write-Output "补入 @earendil-works\$($pkg.Name)"
  }
}
$prior.addedPiPackages = $addedPi
$prior | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $backupDir 'prior-state.json') -Encoding utf8

# ── 6. 改写 package.json 依赖 ──────────────────────────────
Step '改写 profile 依赖'
$pkg = Get-Content -LiteralPath $profilePkg -Raw | ConvertFrom-Json
if ($pkg.dependencies.PSObject.Properties.Name -contains 'dsh-pi') {
  $pkg.dependencies.'dsh-pi' = $depSpec
} else {
  $pkg.dependencies | Add-Member -NotePropertyName 'dsh-pi' -NotePropertyValue $depSpec
}
$pkg | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $profilePkg -Encoding utf8
Write-Output ('"dsh-pi": "{0}"' -f $depSpec)

# ── 7. 回滚脚本 ────────────────────────────────────────────
Step '生成回滚脚本'
$rollback = Join-Path $backupDir ('rollback-' + $stamp + '.ps1')
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# 回滚 dsh-pi 安装（' + $stamp + '）——由 tools\install-plugin.ps1 生成')
$lines.Add('$ErrorActionPreference = ''Stop''')
$lines.Add('$profileDir = ' + "'" + $profileDir + "'")
$lines.Add('$profileModules = Join-Path $profileDir ''node_modules''')
$lines.Add('$pluginDir = Join-Path $profileModules ''dsh-pi''')
$lines.Add('')
$lines.Add('Copy-Item -LiteralPath (Join-Path $PSScriptRoot ''package.json'') -Destination (Join-Path $profileDir ''package.json'') -Force')
$lines.Add('Write-Output ''1/3 已恢复 profile\package.json''')
$lines.Add('')
$lines.Add('if (Test-Path $pluginDir) { Remove-Item -LiteralPath $pluginDir -Recurse -Force }')
if ($prior.kind -eq 'junction') {
  $lines.Add('New-Item -ItemType Junction -Path $pluginDir -Target ' + "'" + $prior.junctionTarget + "'" + ' | Out-Null')
  $lines.Add('Write-Output ''2/3 已恢复 junction -> ' + $prior.junctionTarget + '''')
} elseif ($prior.kind -eq 'dir') {
  $lines.Add('Copy-Item -LiteralPath (Join-Path $PSScriptRoot ''node_modules-dsh-pi'') -Destination $pluginDir -Recurse -Force')
  $lines.Add('Write-Output ''2/3 已恢复原 node_modules\dsh-pi 目录''')
} else {
  $lines.Add('Write-Output ''2/3 原先没有 dsh-pi，保持移除''')
}
$lines.Add('')
foreach ($name in $addedPi) {
  $lines.Add('Remove-Item -LiteralPath (Join-Path $profileModules ''@earendil-works\' + $name + ''') -Recurse -Force -ErrorAction SilentlyContinue')
}
$lines.Add('Write-Output ''3/3 已移除本次补入的 pi 包''')
$lines.Add('Write-Output ''回滚完成。重启 DSH 后生效。''')
$lines | Set-Content -LiteralPath $rollback -Encoding utf8
Write-Output "rollback = $rollback"

# ── 收尾 ──────────────────────────────────────────────────
if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }

Step '完成'
Write-Output "插件已装进 profile『$Profile』。下一步："
Write-Output '  1) 重启 DSH（插件代码在 import 时快照进内存，不重启不生效）'
Write-Output '  2) 侧栏点 pi；若提示缺运行时，点「一键安装 pi」'
Write-Output '  3) 排障：GET http://127.0.0.1:<port>/api/dsh-pi/diagnostics'
Write-Output "  4) 想退回：pwsh -File '$rollback'"
