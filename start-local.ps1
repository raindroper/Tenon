$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '请先安装 Node.js 22.13 或更高版本。' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
}
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw '构建失败，请查看上方错误。' }
Write-Host '榫 Tenon: http://127.0.0.1:4317'
Write-Host '保持此窗口运行；按 Ctrl+C 停止。关闭网页后，后台任务仍会继续。'
& npm.cmd start
