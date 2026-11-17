<#
.SYNOPSIS
    启动 FastAPI 后端（默认监听 0.0.0.0:8000，本机与局域网都能访问）。

.DESCRIPTION
    默认绑 0.0.0.0 是为了用手机 / 另一台电脑打开前端时，API 也能连上。
    只想本机访问就用 -Bind 127.0.0.1。

.EXAMPLE
    .\start-backend.ps1
    .\start-backend.ps1 -Port 8010 -Reload
    .\start-backend.ps1 -Bind 127.0.0.1
#>
[CmdletBinding()]
param(
    [int]$Port = 8000,
    [string]$Bind = "0.0.0.0",
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
    $args = @("-m", "uvicorn", "app.main:app", "--host", $Bind, "--port", "$Port")
    if ($Reload) { $args += "--reload" }
    Write-Host "FastAPI -> http://127.0.0.1:$Port/docs" -ForegroundColor Cyan
    if ($Bind -eq "0.0.0.0") {
        $lan = (Get-NetIPAddress -AddressFamily IPv4 |
            Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
            Select-Object -First 1 -ExpandProperty IPAddress)
        if ($lan) {
            Write-Host "     局域网 -> http://${lan}:$Port/docs" -ForegroundColor DarkCyan
        }
    }
    & $python @args
}
finally { Pop-Location }
