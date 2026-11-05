# Installs MSYS2 into toolchain/msys64 with the tools needed to build TSK / libewf / cgo.
# Usage (PowerShell):  powershell -ExecutionPolicy Bypass -File scripts\setup-msys2.ps1
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Dl   = Join-Path $Root 'downloads'
$Tc   = Join-Path $Root 'toolchain'
$Sfx  = Join-Path $Dl 'msys2-base-x86_64-latest.sfx.exe'
$Msys = Join-Path $Tc 'msys64'
$Bash = Join-Path $Msys 'usr\bin\bash.exe'

New-Item -ItemType Directory -Force $Dl, $Tc | Out-Null

if (-not (Test-Path $Sfx)) {
    Write-Host 'Downloading MSYS2 ...'
    Invoke-WebRequest 'https://repo.msys2.org/distrib/msys2-x86_64-latest.sfx.exe' -OutFile $Sfx
}

if (-not (Test-Path $Bash)) {
    Write-Host "Extracting MSYS2 to $Msys ..."
    & $Sfx -y "-o$Tc" | Out-Null
}

# run a command inside MSYS2 (separate environment, does not inherit Git Bash's MSYS variables)
function Invoke-Msys([string]$cmd) {
    $env:MSYSTEM = 'MINGW64'
    $env:CHERE_INVOKING = '1'
    $env:MSYS2_PATH_TYPE = 'minimal'
    & $Bash -lc $cmd
    if ($LASTEXITCODE -ne 0) { throw "MSYS2 command failed: $cmd" }
}

Write-Host 'Initializing MSYS2 ...'
Invoke-Msys 'true'

# the official mirrors are unreliable from mainland China: put Tsinghua / USTC first (safe to run repeatedly)
Write-Host 'Configuring mirrors ...'
Set-Location $Root
Invoke-Msys './scripts/msys2-mirrors.sh'

Write-Host 'Updating MSYS2 (runs twice when core packages are updated) ...'
& $Bash -lc 'pacman -Syu --noconfirm' | Out-Host
Invoke-Msys 'pacman -Syu --noconfirm'

Write-Host 'Installing build tools ...'
Invoke-Msys 'pacman -S --needed --noconfirm make mingw-w64-x86_64-gcc mingw-w64-x86_64-autotools mingw-w64-x86_64-pkgconf mingw-w64-x86_64-zlib'

# Some software installs old MinGW runtime DLLs into C:\Windows\System32, and Windows prefers
# System32 over PATH, so cc1.exe fails with 0xC0000139 (entry point not found).
# Windows looks in the program's own directory first, so copying matching DLLs next to GCC's internal programs is enough; system files stay untouched.
Invoke-Msys 'for d in /mingw64/lib/gcc/x86_64-w64-mingw32/*/; do cp -f /mingw64/bin/libwinpthread-1.dll /mingw64/bin/libgcc_s_seh-1.dll /mingw64/bin/libstdc++-6.dll "$d"; done'

Invoke-Msys 'gcc --version | head -1'
Write-Host 'MSYS2 is ready.'
