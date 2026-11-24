param([string]$WorkDir = '')

& (Join-Path $PSScriptRoot 'launch-both.ps1') -NoWeb -Resume pick -WorkDir $WorkDir
exit $LASTEXITCODE
