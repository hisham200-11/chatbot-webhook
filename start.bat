@echo off
title Dental AI Webhook Launcher
echo ============================================================
echo Starting Dental AI Webhook Server and Cloudflare Tunnel...
echo ============================================================

start "1. Dental AI Node Server (Port 3000)" cmd /k "node index.js"
timeout /t 2 >nul
start "2. Cloudflare Public Tunnel" cmd /k "cloudflared tunnel --url http://127.0.0.1:3000"

echo.
echo Both services have launched in separate windows!
echo Copy the trycloudflare.com URL from Window #2 to your Meta Webhook.
echo.
pause