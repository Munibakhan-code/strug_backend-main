# Start local dependencies for Strug Live E2E (Redis, Postgres, MediaMTX).
# Run backend and frontend separately in their own terminals.
#
# Usage: .\scripts\dev-live-stack.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

Write-Host "=== Strug Live dev stack ===" -ForegroundColor Cyan

try {
  docker info | Out-Null
} catch {
  Write-Host "Docker is not running. Start Docker Desktop, then re-run this script." -ForegroundColor Red
  exit 1
}

# Redis
$redis = docker ps -a --filter "name=strug-redis" --format "{{.Names}}"
if (-not $redis) {
  Write-Host "Creating strug-redis..."
  docker run -d --name strug-redis -p 6379:6379 redis:7-alpine
} else {
  Write-Host "Starting strug-redis..."
  docker start strug-redis | Out-Null
}

# Postgres (port 5433 — avoids conflict with existing Postgres on 5432)
$pg = docker ps -a --filter "name=strug-local-db" --format "{{.Names}}"
if (-not $pg) {
  Write-Host "Creating strug-local-db on port 5433..."
  docker run -d --name strug-local-db `
    -e POSTGRES_USER=strug `
    -e POSTGRES_PASSWORD=strug `
    -e POSTGRES_DB=strug `
    -p 5433:5432 `
    postgres:16-alpine
  Write-Host "Waiting for Postgres..."
  Start-Sleep -Seconds 5
} else {
  Write-Host "Starting strug-local-db..."
  docker start strug-local-db | Out-Null
}

# MediaMTX
$mtxDir = Join-Path $Root "infra\mediamtx"
if (Test-Path $mtxDir) {
  Push-Location $mtxDir
  if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created infra/mediamtx/.env from .env.example"
  }
  Write-Host "Starting MediaMTX (RTMP :1935, HLS :8888)..."
  docker compose up -d
  Pop-Location
} else {
  Write-Warning "MediaMTX folder not found at $mtxDir"
}

Write-Host ""
Write-Host "Docker services started." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. cd strug_backend-main && npm run dev    (port 5000)"
Write-Host "  2. cd strug-final-frontend && npm run dev (port 5173)"
Write-Host "  3. Login -> /provider/streamer -> Go Live -> OBS rtmp://127.0.0.1:1935"
Write-Host "  4. Open /live to watch"
Write-Host ""
Write-Host "Backend LIVE_* must match infra/mediamtx/.env (LIVE_HOOK_SECRET)."
