# Sync the vendored SpriteForge copy from its source folder.
#
#   .\tools\sync-spriteforge.ps1            # copy
#   .\tools\sync-spriteforge.ps1 -Check     # compare only, no writes
#
# The files are served verbatim by Next from frontend/public/tools/spriteforge,
# so keep them byte-identical to the source project.

param(
    [string] $Source = "D:\AI\SpriteForge",
    [switch] $Check
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $repoRoot "frontend\public\tools\spriteforge"
$files = @("index.html", "styles.css", "app.js")

if (-not (Test-Path $Source)) {
    throw "找不到 SpriteForge 源码目录：$Source"
}

if (-not (Test-Path $target)) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
}

$drift = 0

foreach ($name in $files) {
    $from = Join-Path $Source $name
    $to = Join-Path $target $name

    if (-not (Test-Path $from)) {
        throw "源码里缺少 $name"
    }

    $src = Get-Item $from
    $same = $false

    if (Test-Path $to) {
        $dst = Get-Item $to
        $same = ($dst.Length -eq $src.Length) -and
            ((Get-FileHash $from -Algorithm SHA256).Hash -eq (Get-FileHash $to -Algorithm SHA256).Hash)
    }

    if ($Check) {
        if ($same) {
            "{0,-12} 一致  {1,9:N0} B" -f $name, $src.Length
        }
        else {
            $drift++
            "{0,-12} 不一致 源 {1,9:N0} B" -f $name, $src.Length
        }
        continue
    }

    Copy-Item $from $to -Force
    "{0,-12} 已同步  {1,9:N0} B" -f $name, $src.Length
}

if ($Check) {
    if ($drift -gt 0) {
        Write-Host ""
        Write-Host "有 $drift 个文件与源码不同，运行不带 -Check 的命令同步。" -ForegroundColor Yellow
        exit 1
    }
    Write-Host ""
    Write-Host "全部一致。" -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "完成：$target" -ForegroundColor Green
