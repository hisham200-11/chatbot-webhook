@echo off
setlocal enabledelayedexpansion
title Dental AI Webhook Launcher

set PORT=3000
if exist .env (
    for /f "usebackq tokens=1,2 delims==" %%A in (".env") do (
        if "%%A"=="PORT" set PORT=%%B
    )
)

echo ============================================================
echo Starting Dental AI Webhook on PORT %PORT%...
echo ============================================================

start "1. Dental AI Node Server (Port %PORT%)" cmd /k "node index.js"
timeout /t 2 >nul
start "2. Cloudflare Public Tunnel" cmd /k "cloudflared tunnel --url http://127.0.0.1:%PORT%"

echo.
echo Both services have launched on port %PORT%!
echo Copy the trycloudflare.com URL from Window #2 to your Meta Webhook.
echo.
pause