@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo   VS System - Remote access (PC = server)
echo   Klienti NAV vajadzīgi tavā Wi-Fi
echo ========================================
echo.
echo Prasiba: vispirms palaid start-vs-system.bat
echo          (web http://localhost:3000 jau strada)
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js nav atrasts
  pause
  exit /b 1
)

echo Starting Cloudflare quick tunnel...
echo Logu NEAIIZVER - kamēr klientiem vajag piekļuvi.
echo.
node "%~dp0scripts\start-tunnel.mjs"
pause
exit /b 0
