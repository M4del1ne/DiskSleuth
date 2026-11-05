# Runs build-deps.sh inside the MSYS2 MINGW64 environment.
# Usage (PowerShell):  powershell -ExecutionPolicy Bypass -File scripts\build-deps.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Bash = Join-Path $Root 'toolchain\msys64\usr\bin\bash.exe'
if (-not (Test-Path $Bash)) { throw 'MSYS2 not found, run scripts\setup-msys2.ps1 first' }

$env:MSYSTEM = 'MINGW64'
$env:CHERE_INVOKING = '1'
$env:MSYS2_PATH_TYPE = 'minimal'
Set-Location $Root
& $Bash -lc './scripts/build-deps.sh'
if ($LASTEXITCODE -ne 0) { throw "build-deps.sh failed (exit code $LASTEXITCODE)" }
