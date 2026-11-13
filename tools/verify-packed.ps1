# 打包 → 装到临时目录 → 用打包产物跑真实 LLM 往返
# 用法：pwsh -File tools/verify-packed.ps1
param([string]$Keep = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$env:HTTPS_PROXY = "http://127.0.0.1:10808"
$env:HTTP_PROXY = "http://127.0.0.1:10808"

Get-ChildItem -Path $root -Filter "*.tgz" | Remove-Item -Force
Write-Output "=== npm pack ==="
$packJson = npm pack --json 2>&1 | Out-String
$pack = $packJson | ConvertFrom-Json
Write-Output ("tarball = " + $pack[0].filename + "  size = " + $pack[0].size + "  files = " + $pack[0].entryCount)
$tgz = Join-Path $root $pack[0].filename

$tmp = Join-Path $env:TEMP ("dsh-pi-packed-" + [guid]::NewGuid().ToString("N").Substring(0, 6))
New-Item -ItemType Directory -Path $tmp | Out-Null
Set-Location $tmp
'{ "name": "packed-probe", "private": true, "type": "module" }' | Set-Content -Path package.json -Encoding utf8

Write-Output "=== install into $tmp ==="
npm install $tgz --no-audit --no-fund --loglevel=error 2>&1 | Select-Object -Last 5
Write-Output ("installExit=$LASTEXITCODE")

$installed = Join-Path $tmp "node_modules\dsh-pi"
Write-Output ("shipped files  = " + (Get-ChildItem $installed -Recurse -File | Measure-Object).Count)
Write-Output ("hoisted pi     = " + (Test-Path (Join-Path $tmp "node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js")))
Write-Output ("plugin .runtime= " + (Test-Path (Join-Path $installed ".runtime")))

Set-Location $root
Write-Output "=== packed smoke (real LLM round trip) ==="
node (Join-Path $root "test\packed-smoke.mjs") (Join-Path $installed "index.js") 2>&1 | Select-Object -Last 28
$smokeExit = $LASTEXITCODE
Write-Output "smokeExit=$smokeExit"

if ($Keep -ne "keep") {
  Set-Location $root
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Write-Output "temp removed: $tmp"
} else {
  Write-Output "temp kept: $tmp"
}
exit $smokeExit
