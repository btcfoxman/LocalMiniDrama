# Start development environment: backend + frontend
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Starting backend service (backend-node)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\backend-node'; npm run dev" -WindowStyle Normal

Write-Host "Starting frontend service (frontweb)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontweb'; npm run dev" -WindowStyle Normal

Write-Host "Development servers started." -ForegroundColor Green
Write-Host "  Backend:  http://localhost:5679" -ForegroundColor Yellow
Write-Host "  Frontend: http://localhost:3013" -ForegroundColor Yellow
