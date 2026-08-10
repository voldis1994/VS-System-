@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title VS System — BACKUP DB (konti)
echo ========================================
echo   VS SYSTEM — DB BACKUP
echo   Saglaba Postgres ^(konti + Capital keys^)
echo ========================================
echo.

where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker nav
  pause
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker Engine nestrada
  pause
  exit /b 1
)

if not exist "backups" mkdir backups

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TS=%%i"
set "OUT=%~dp0backups\vs-system-db-%TS%.sql"

echo Dump no konteinera nexus-postgres...
docker exec nexus-postgres pg_dump -U nexus -d nexus_pro --clean --if-exists > "%OUT%"
if errorlevel 1 (
  echo.
  echo ERROR: dump neizdevas — vai Postgres skrien? Palaid START-VS-SYSTEM.bat
  pause
  exit /b 1
)

for %%A in ("%OUT%") do set "SZ=%%~zA"
if "%SZ%"=="0" (
  echo ERROR: fails tukss
  del "%OUT%" >nul 2>&1
  pause
  exit /b 1
)

echo.
echo   OK: %OUT%
echo   Izmers: %SZ% baiti
echo.
echo   RESTORE: RESTORE-DB.bat
echo ========================================
pause
exit /b 0
