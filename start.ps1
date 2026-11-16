<#
.SYNOPSIS
    一条命令启动 MiraForge：检查 ComfyUI → 起后端 → 起前端 → 等就绪 → 打开浏览器。

.DESCRIPTION
    后端（Python/FastAPI）与前端（Node/Next.js）是两个独立运行时，本脚本把它们
    各自放进一个新窗口启动，这样关掉这个脚本也不影响它们；要停就用 .\stop.ps1。

.PARAMETER BackendPort
    FastAPI 端口，默认 8000。

.PARAMETER FrontendPort
    Next.js 端口，默认 3000。

.PARAMETER StartComfyUI
    ComfyUI 没在跑时，顺手用 run_nvidia_gpu.bat 起一个。

.PARAMETER NoBrowser
    不自动打开浏览器。

.EXAMPLE
    .\start.ps1

.EXAMPLE
    .\start.ps1 -StartComfyUI
#>
[CmdletBinding()]
param(
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 3000,
    [switch]$StartComfyUI,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$python = Join-Path $root "backend\.venv\Scripts\python.exe"
$nodeModules = Join-Path $root "frontend\node_modules"
$comfyBat = "D:\AI\ComfyUI_Portable\run_nvidia_gpu.bat"

function Test-PortOpen([int]$Port) {
    [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Test-ComfyUI {
    try {
        $r = Invoke-RestMethod "http://127.0.0.1:8188/system_stats" -TimeoutSec 3
        return [bool]$r.system.comfyui_version
    }
    catch { return $false }
}

function Wait-Url([string]$Url, [int]$TimeoutSeconds, [int]$IntervalMs = 1000) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 5
            if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) { return $true }
        }
        catch { }
        Start-Sleep -Milliseconds $IntervalMs
    }
    return $false
}

Write-Host ""
Write-Host "  MiraForge 启动检查" -ForegroundColor Cyan
Write-Host "  ------------------" -ForegroundColor DarkGray

if (-not (Test-Path $python)) {
    Write-Host "  [错误] 未找到 backend\.venv，请先运行 .\setup.ps1" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $nodeModules)) {
    Write-Host "  [错误] 未找到 frontend\node_modules，请先运行 .\setup.ps1" -ForegroundColor Red
    exit 1
}
Write-Host "  [ok] Python 虚拟环境与前端依赖已就绪" -ForegroundColor DarkGray

# 1. ComfyUI
$comfyUp = Test-ComfyUI
if (-not $comfyUp) {
    if ($StartComfyUI -and (Test-Path $comfyBat)) {
        Write-Host "  [..] ComfyUI 未运行，正在启动 run_nvidia_gpu.bat（首次加载模型约 10-60 秒）" -ForegroundColor Yellow
        Start-Process -FilePath $comfyBat -WorkingDirectory (Split-Path $comfyBat)
        $comfyUp = Wait-Url "http://127.0.0.1:8188/system_stats" 180
    }
}
if ($comfyUp) {
    Write-Host "  [ok] ComfyUI 在线 (127.0.0.1:8188)" -ForegroundColor Green
}
else {
    Write-Host "  [警告] ComfyUI 未运行：页面能打开、任务能提交，但不会出图。" -ForegroundColor Yellow
    Write-Host "         请另开窗口运行 D:\AI\ComfyUI_Portable\run_nvidia_gpu.bat，或下次用 .\start.ps1 -StartComfyUI" -ForegroundColor Yellow
}

# 2. 后端
if (Test-PortOpen $BackendPort) {
    Write-Host "  [ok] 后端已在运行 (127.0.0.1:$BackendPort)，跳过" -ForegroundColor Green
}
else {
    Write-Host "  [..] 启动后端 (FastAPI, 127.0.0.1:$BackendPort)" -ForegroundColor DarkGray
    $cmd = "& '$root\start-backend.ps1' -Port $BackendPort"
    Start-Process -FilePath "pwsh" -ArgumentList @("-NoExit", "-Command", $cmd) -WorkingDirectory $root | Out-Null
    if (-not (Wait-Url "http://127.0.0.1:$BackendPort/api/v1/health" 90)) {
        Write-Host "  [错误] 后端 90 秒内没有起来，请查看弹出的那个窗口里的报错" -ForegroundColor Red
        exit 1
    }
    Write-Host "  [ok] 后端就绪 http://127.0.0.1:$BackendPort/docs" -ForegroundColor Green
}

# 3. 前端
if (Test-PortOpen $FrontendPort) {
    Write-Host "  [ok] 前端已在运行 (127.0.0.1:$FrontendPort)，跳过" -ForegroundColor Green
}
else {
    Write-Host "  [..] 启动前端 (Next.js, 127.0.0.1:$FrontendPort)" -ForegroundColor DarkGray
    $cmd = "& '$root\start-frontend.ps1' -Port $FrontendPort"
    Start-Process -FilePath "pwsh" -ArgumentList @("-NoExit", "-Command", $cmd) -WorkingDirectory $root | Out-Null
    # dev 模式首次访问要现编译，给足时间
    if (-not (Wait-Url "http://127.0.0.1:$FrontendPort" 180)) {
        Write-Host "  [错误] 前端 180 秒内没有起来，请查看弹出的那个窗口里的报错" -ForegroundColor Red
        exit 1
    }
    Write-Host "  [ok] 前端就绪 http://127.0.0.1:$FrontendPort" -ForegroundColor Green
}

$url = "http://127.0.0.1:$FrontendPort"
Write-Host ""
Write-Host "  打开：$url   （等价的：http://localhost:$FrontendPort）" -ForegroundColor Cyan
Write-Host "  停止：.\stop.ps1" -ForegroundColor DarkGray
Write-Host ""

if (-not $NoBrowser) { Start-Process $url }
