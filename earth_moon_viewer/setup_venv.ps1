#!/usr/bin/env pwsh
# Create a virtual environment in .venv and install requirements
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$venv = Join-Path $root '.venv'
if (-not (Test-Path $venv)) {
    python -m venv $venv
    Write-Host "Created virtual environment at $venv"
} else {
    Write-Host "Virtual environment already exists at $venv"
}

# Use the venv's python to install/upgrade pip and install requirements
& (Join-Path $venv 'Scripts\python.exe') -m pip install --upgrade pip
& (Join-Path $venv 'Scripts\python.exe') -m pip install -r (Join-Path $root 'requirements.txt')

Write-Host "To activate (PowerShell):`n  & $venv\Scripts\Activate.ps1"
Write-Host "To activate (cmd.exe):`n  $venv\Scripts\activate.bat"