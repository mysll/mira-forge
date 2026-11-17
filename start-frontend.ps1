<#
.SYNOPSIS
    启动 Next.js 前端（默认监听 0.0.0.0:3000，本机与局域网都能打开）。

.DESCRIPTION
    `next dev -H 0.0.0.0` 让同一局域网的手机 / 另一台电脑可以打开
    http://<本机IP>:3000。前端会按「当前页面的主机名 + 8000」找后端，
    所以后端也要监听 0.0.0.0（见 start-backend.ps1）。

.EXAMPLE
    .\start-frontend.ps1
    .\start-frontend.ps1 -Port 3001
    .\start-frontend.ps1 -Bind 127.0.0.1
#>
[CmdletBinding()]
param(
    [int]$Port = 3000,
    [string]$Bind = "0.0.0.0"
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
    if ($Bind -eq "0.0.0.0") {
        $lan = (Get-NetIPAddress -AddressFamily IPv4 |
            Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
            Select-Object -First 1 -ExpandProperty IPAddress)
        if ($lan) {
            Write-Host "     局域网 -> http://${lan}:$Port" -ForegroundColor DarkCyan
        }
    }
    npx next dev -H $Bind -p $Port
}
finally { Pop-Location }
