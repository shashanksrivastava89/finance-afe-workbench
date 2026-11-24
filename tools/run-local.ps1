# Start the AFE Workbench locally.
#
# There is nothing secret to fetch: the app has no AI services (R62), and DocuSign, mail
# and the SAP ingest all stand in when their settings are absent. Pass -Database to run
# against the UAT Postgres instead of memory; the URL is read from the environment, never
# from disk (ADC rule: no .env files, no credentials in source).
#
#   pwsh tools/run-local.ps1                     # in-memory, everything simulated
#   pwsh tools/run-local.ps1 -Database           # against AFE_DATABASE_URL, or the local
#                                                # docker-compose Postgres when that is unset
param([switch]$Database)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

if ($Database) {
  if ($env:AFE_DATABASE_URL) {
    $env:DATABASE_URL = $env:AFE_DATABASE_URL
    Write-Host "Using Postgres from AFE_DATABASE_URL." -ForegroundColor Green
  } else {
    # The development database from docker-compose.yml. Its password is a local default, not a
    # secret: the container listens on the loopback interface only. A real database is always
    # passed in through AFE_DATABASE_URL (or App Service settings), never read from the repo.
    $running = (docker ps --filter "name=afe-postgres" --filter "status=running" --format "{{.Names}}" 2>$null)
    if (-not $running) {
      throw "No database. Either start the local one (docker compose up -d db) or set AFE_DATABASE_URL."
    }
    $port = if ($env:POSTGRES_PORT) { $env:POSTGRES_PORT } else { "5434" }
    # sslmode=disable because the container speaks no TLS; anything remote is encrypted by
    # default (lib/repos/pgStore.js decides from the URL, never from the host name).
    $env:DATABASE_URL = "postgres://afe:afe_dev@127.0.0.1:$port/afe?sslmode=disable"
    Write-Host "Using the local Postgres from docker-compose (port $port)." -ForegroundColor Green
  }
} else {
  Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
  Write-Host "In-memory store; DocuSign simulated; mail as .eml download." -ForegroundColor DarkGray
}

# Free the port if a previous run is still holding it.
Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

Write-Host "Serving on http://127.0.0.1:8080  (Ctrl+C to stop)" -ForegroundColor Cyan
Write-Host "Verify with: node tools/smoke-boot.js; node tools/smoke-wizard.js" -ForegroundColor DarkGray
# Development only: no Easy Auth in front of this process, so say so explicitly rather than
# letting server.js assume it. Neither switch has a default in the app.
if (-not $env:DEMO_MODE) { $env:DEMO_MODE = "1" }
if (-not $env:UNAUTHENTICATED_AS) { $env:UNAUTHENTICATED_AS = "shashank_srivastava@example.com" }

node tools/run-local.js
