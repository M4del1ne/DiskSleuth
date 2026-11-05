# Builds the Go backend (cgo, statically linked against TSK + libewf in deps/).
# Usage (PowerShell):  powershell -ExecutionPolicy Bypass -File scripts\build-backend.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$MingwBin = Join-Path $Root 'toolchain\msys64\mingw64\bin'
if (-not (Test-Path (Join-Path $Root 'deps\lib\libtsk.a'))) { throw 'deps\lib\libtsk.a not found, run scripts\build-deps.ps1 first' }

$env:PATH = "$MingwBin;" + $env:PATH
$env:CGO_ENABLED = '1'
$env:CC = 'gcc'
$env:CXX = 'g++'
# Use the local Go version; never let the go command download a newer toolchain because of a dependency
$env:GOTOOLCHAIN = 'local'
# The Go build cache does not notice changes to external .a libraries: put a hash of them into the cgo flags (part of the cache key)
# so rebuilt deps trigger a recompile/relink instead of linking stale libraries.
$depsHash = (Get-ChildItem (Join-Path $Root 'deps\lib\*.a') | ForEach-Object { (Get-FileHash $_ -Algorithm SHA256).Hash }) -join ''
$depsHash = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::ASCII.GetBytes($depsHash))) -Algorithm SHA256).Hash.Substring(0, 16)
$env:CGO_CFLAGS = "-DFORENSICS_DEPS_HASH=$depsHash"
$Out = Join-Path $Root 'build\bin'
New-Item -ItemType Directory -Force $Out | Out-Null

Set-Location (Join-Path $Root 'backend')
go vet ./...
if ($LASTEXITCODE -ne 0) { throw 'go vet failed' }
go build -o $Out ./cmd/...
if ($LASTEXITCODE -ne 0) { throw 'go build failed' }
Write-Host "Built into $Out"
