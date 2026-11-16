<#
.SYNOPSIS
    停止 MiraForge 的后端与前端（可选连 ComfyUI 一起停）。

.DESCRIPTION
    按端口找占用进程再结束它，所以不管是谁启动的（start.ps1 弹出的窗口、
    手动开的终端、编辑器里的终端）都能停干净。

.PARAMETER BackendPort
    FastAPI 端口，默认 8000。

.PARAMETER FrontendPort
    Next.js 端口，默认 3000。

.PARAMETER IncludeComfyUI
    同时停掉 8188 上的 ComfyUI。

.EXAMPLE
    .\stop.ps1

.EXAMPLE
    .\stop.ps1 -IncludeComfyUI
#>
[CmdletBinding()]
param(
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 3000,
    [switch]$IncludeComfyUI
)

$ErrorActionPreference = "Stop"

function Stop-Port([int]$Port, [string]$Name) {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) {
        Write-Host "  [--] $Name ($Port) 本来就没在运行" -ForegroundColor DarkGray
        return
    }
    $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $pids) {
        try {
            $p = Get-Process -Id $procId -ErrorAction Stop
            Stop-Process -Id $procId -Force -ErrorAction Stop
            Write-Host "  [ok] 已停止 $Name ($Port) pid=$procId ($($p.ProcessName))" -ForegroundColor Green
        }
        catch {
            Write-Host "  [警告] 无法停止 $Name ($Port) 的 pid=$procId：$($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

Write-Host ""
Write-Host "  MiraForge 停止" -ForegroundColor Cyan
Write-Host "  --------------" -ForegroundColor DarkGray

Stop-Port $FrontendPort "前端"
Stop-Port $BackendPort "后端"
if ($IncludeComfyUI) { Stop-Port 8188 "ComfyUI" }

Write-Host ""
