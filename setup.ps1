<#
.SYNOPSIS
    一次性初始化 MiraForge 开发环境。

.DESCRIPTION
    - 后端：创建 backend\.venv，并用 uv 安装依赖（本机 python -m venv 的 ensurepip 会失败）
    - 前端：npm install（缓存指向项目内目录，避开 AppData 写入限制）
    - 复制 .env 样板文件、执行 alembic 迁移
    幂等：已存在 venv / node_modules / .env 时不会重建。
#>
[CmdletBinding()]
param(
    [string]$Python = "C:\Program Files\Python312\python.exe"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"

function Find-Uv {
    $candidates = @(
        (Join-Path (Split-Path $Python) "Scripts\uv.exe"),
        "uv.exe"
    )
    foreach ($candidate in $candidates) {
        $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    throw "未找到 uv。请先安装：pip install uv 或从 https://docs.astral.sh/uv/ 获取。"
}

Write-Host "== MiraForge setup ==" -ForegroundColor Cyan

# ---- 后端 ----
$venvPython = Join-Path $backend ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "[backend] creating venv ..." -ForegroundColor Yellow
    & $Python -m venv --without-pip (Join-Path $backend ".venv")
    if ($LASTEXITCODE -ne 0) { throw "venv 创建失败" }
}

$uv = Find-Uv
$env:UV_CACHE_DIR = Join-Path $root ".cache\uv"
Write-Host "[backend] installing requirements via uv ..." -ForegroundColor Yellow
& $uv pip install --python $venvPython -r (Join-Path $backend "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "后端依赖安装失败" }

foreach ($pair in @(@(".env.example", ".env"))) {
    $src = Join-Path $backend $pair[0]
    $dst = Join-Path $backend $pair[1]
    if ((Test-Path $src) -and -not (Test-Path $dst)) {
        Copy-Item $src $dst
        Write-Host "[backend] created backend\$($pair[1])" -ForegroundColor Yellow
    }
}

Write-Host "[backend] running alembic upgrade head ..." -ForegroundColor Yellow
Push-Location $backend
try {
    & $venvPython -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { throw "数据库迁移失败" }
}
finally { Pop-Location }

# ---- 前端 ----
if (-not (Test-Path (Join-Path $frontend "node_modules"))) {
    Write-Host "[frontend] npm install ..." -ForegroundColor Yellow
    Push-Location $frontend
    try {
        $env:npm_config_cache = Join-Path $root ".npm-cache"
        npm install
        if ($LASTEXITCODE -ne 0) { throw "前端依赖安装失败" }
    }
    finally { Pop-Location }
}

$envLocalExample = Join-Path $frontend ".env.local.example"
$envLocal = Join-Path $frontend ".env.local"
if ((Test-Path $envLocalExample) -and -not (Test-Path $envLocal)) {
    Copy-Item $envLocalExample $envLocal
    Write-Host "[frontend] created frontend\.env.local" -ForegroundColor Yellow
}

Write-Host "`n完成。启动方式：" -ForegroundColor Green
Write-Host "  .\start-backend.ps1"
Write-Host "  .\start-frontend.ps1"
