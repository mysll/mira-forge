<#
.SYNOPSIS
    启动 Next.js 前端（默认 http://127.0.0.1:3000）。

.EXAMPLE
    .\start-frontend.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$frontend = Join-Path $PSScriptRoot "frontend"

if (-not (Test-Path (Join-Path $frontend "node_modules"))) {
    throw "未找到 frontend\node_modules，请先运行 .\setup.ps1"
}

if (-not (Test-Path (Join-Path $frontend ".env.local"))) {
    Copy-Item (Join-Path $frontend ".env.local.example") (Join-Path $frontend ".env.local")
}

Push-Location $frontend
try {
    $env:NEXT_TELEMETRY_DISABLED = "1"
    Write-Host "Next.js -> http://127.0.0.1:$Port" -ForegroundColor Cyan
    npx next dev -p $Port
}
finally { Pop-Location }
