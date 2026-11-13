# Ensure every .ps1 under tools that contains non-ASCII text starts with a UTF-8 BOM.
#
# Why: Windows PowerShell 5.1 decodes a .ps1 with no BOM as ANSI (GBK on zh-CN), so a
# UTF-8 file with Chinese text turns into garbage tokens and the script fails to parse.
# Edits made by tools that rewrite the file (including some editors) silently drop the BOM,
# so run this after editing, and in CI before publishing.
#
# This file is intentionally ASCII-only so that it can itself run under 5.1 without a BOM.
param([string]$Root = $PSScriptRoot)

$fix = 0
$ok = 0
foreach ($f in Get-ChildItem -LiteralPath $Root -Filter *.ps1 -File) {
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $nonAscii = $false
  foreach ($b in $bytes) { if ($b -gt 0x7F) { $nonAscii = $true; break } }
  if (-not $nonAscii) { $ok++; continue }
  if ($hasBom) { $ok++; continue }
  $text = [System.Text.Encoding]::UTF8.GetString($bytes)
  [System.IO.File]::WriteAllText($f.FullName, $text, (New-Object System.Text.UTF8Encoding($true)))
  Write-Output ("added BOM: " + $f.Name)
  $fix++
}
Write-Output ("ps1 files ok: $ok, BOM added: $fix")
if ($fix -gt 0) { exit 0 } else { exit 0 }
