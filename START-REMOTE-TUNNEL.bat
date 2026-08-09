@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title VS System — REMOTE TUNNEL
echo ========================================
echo   VS SYSTEM — remote tunnel (opcijas)
echo ========================================
echo.
echo   Parasti NAV vajadzigs.
echo   Stabilais links klientiem (viena Wi-Fi):
echo     skati client-url.txt  —  http://PC-IP:3000/client
echo.
echo   Sis bat ir TIKAI ja klients ir citā tīklā / 4G.
echo.
echo   SVARIGI: brivais Cloudflare quick tunnel
echo   KATRU REIZI uzģenerē JAUNU *.trycloudflare.com adresi.
echo   Tas NAV VS System bug — tā strādā Cloudflare free.
echo   Tāpēc START vairs nepalaiž tunnel automātiski.
echo.
echo   Ja vajag VIENU pastāvīgu remote URL — vajag
echo   Cloudflare named tunnel (sava subdomena) — nav free quick.
echo.
pause

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js nav atrasts
  pause
  exit /b 1
)

echo.
echo Parbaudu vai Web skrien uz :3000...
netstat -ano | findstr ":3000 " | findstr LISTENING >nul
if errorlevel 1 (
  echo ERROR: ports 3000 nav atverts — vispirms START-VS-SYSTEM.bat
  pause
  exit /b 1
)

echo.
echo Startēju tunnel... logu NEAIZVER.
echo URL parādīsies šeit + remote-client-url.txt
echo.
node scripts\start-tunnel.mjs
pause
exit /b 0
