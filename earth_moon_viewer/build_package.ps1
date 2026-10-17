param(
  [string]$OutName = "earth_moon_viewer.zip"
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Push-Location $root
Write-Host "Creating package $OutName from $root"

# Exclude virtualenvs and git metadata
$items = Get-ChildItem -File -Recurse | Where-Object { $_.FullName -notmatch '\.venv|\\.git\\|__pycache__' }

if (Test-Path $OutName) { Remove-Item $OutName }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($root, $OutName)

Write-Host "Package created: $OutName"
Pop-Location
