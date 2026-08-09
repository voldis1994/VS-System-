@echo off
setlocal EnableExtensions
cd /d "%~dp0"

color 0A
call "%~dp0scripts\matrix-look.bat"

title VS System — STOP
echo ========================================
echo   VS SYSTEM — apturešana
echo ========================================
echo.

echo [1/3] Apturu API/Web (porti 3000 / 4000)...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTENING') do (
  echo   kill PID %%p ^(3000^)
  taskkill /F /PID %%p >nul 2>&1
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4000 " ^| findstr LISTENING') do (
  echo   kill PID %%p ^(4000^)
  taskkill /F /PID %%p >nul 2>&1
)

echo [2/3] Apturu Docker Postgres + Redis...
docker compose stop postgres redis 2>nul

echo [3/3] Tunnel logu aizver ar X vai Ctrl+C ^(VS System TUNNEL^).
echo.
echo Gatavs.
pause
exit /b 0
