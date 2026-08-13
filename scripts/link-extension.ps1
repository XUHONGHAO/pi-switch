# Link this repo into pi's global extensions dir via a directory junction.
# After linking, edit sources in-place and run /reload inside pi — no copy needed.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\link-extension.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\link-extension.ps1 -Unlink

param(
  [switch]$Unlink
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ExtRoot = Join-Path $env:USERPROFILE ".pi\agent\extensions"
$LinkPath = Join-Path $ExtRoot "pi-switch"

New-Item -ItemType Directory -Force -Path $ExtRoot | Out-Null

function Get-LinkInfo([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return Get-Item -LiteralPath $Path -Force
}

if ($Unlink) {
  $item = Get-LinkInfo $LinkPath
  if (-not $item) {
    Write-Host "Nothing to unlink: $LinkPath"
    exit 0
  }
  if ($item.LinkType -eq "Junction" -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    # Remove junction only; do not touch the development tree.
    cmd /c "rmdir `"$LinkPath`""
    Write-Host "Unlinked junction: $LinkPath"
  } else {
    throw "Refusing to remove non-junction path: $LinkPath (back it up and delete manually if intended)"
  }
  exit 0
}

$existing = Get-LinkInfo $LinkPath
if ($existing) {
  $isReparse = [bool]($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)
  if ($isReparse -or $existing.LinkType -eq "Junction") {
    $target = @($existing.Target)[0]
    if ($target -and ((Resolve-Path -LiteralPath $target).Path -eq $RepoRoot)) {
      Write-Host "Already linked:"
      Write-Host "  $LinkPath"
      Write-Host "  -> $RepoRoot"
      exit 0
    }
    $stamp = Get-Date -Format "yyyyMMddHHmmss"
    $bak = "$LinkPath.bak-$stamp"
    Rename-Item -LiteralPath $LinkPath -NewName (Split-Path $bak -Leaf)
    Write-Host "Moved previous link aside: $bak"
  } else {
    $stamp = Get-Date -Format "yyyyMMddHHmmss"
    $bak = "$LinkPath.bak-$stamp"
    Rename-Item -LiteralPath $LinkPath -NewName (Split-Path $bak -Leaf)
    Write-Host "Moved previous install aside: $bak"
  }
}

New-Item -ItemType Junction -Path $LinkPath -Target $RepoRoot | Out-Null
$version = (Get-Content -LiteralPath (Join-Path $LinkPath "package.json") -Raw | ConvertFrom-Json).version

Write-Host "Linked pi-switch v$version"
Write-Host "  $LinkPath"
Write-Host "  -> $RepoRoot"
Write-Host ""
Write-Host "Next:"
Write-Host "  1. start pi normally (auto-discovers extensions)"
Write-Host "  2. after code changes, run /reload inside pi"
Write-Host "  3. to remove the link later: .\\scripts\\link-extension.ps1 -Unlink"
