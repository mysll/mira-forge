<#
.SYNOPSIS
    启动 FastAPI 后端（默认 http://127.0.0.1:8000）。

.EXAMPLE
    .\start-backend.ps1
    .\start-backend.ps1 -Port 8010 -Reload
#>
[CmdletBinding()]
param(
    [int]$Port = 8000,
    [switch]$Reload
)

$ErrorActionPreference = "Stop"
$backend = Join-Path $PSScriptRoot "backend"
$python = Join-Path $backend ".venv\Scripts\python.exe"

if (-not (Test-Path $python)) {
    throw "未找到 backend\.venv，请先运行 .\setup.ps1"
}

Push-Location $backend
try {
    $env:PYTHONIOENCODING = "utf-8"
    $args = @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "$Port")
    if ($Reload) { $args += "--reload" }
    Write-Host "FastAPI -> http://127.0.0.1:$Port/docs" -ForegroundColor Cyan
    & $python @args
}
finally { Pop-Location }
