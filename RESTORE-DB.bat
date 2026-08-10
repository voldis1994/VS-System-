@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title VS System — RESTORE DB (konti)
echo ========================================
echo   VS SYSTEM — DB RESTORE
echo   Atjauno kontus no backups\*.sql
echo ========================================
echo.
echo SVARIGI: STOP-VS-SYSTEM.bat vispirms ^(API/WEB aizver^).
echo   Esošie dati tiks PĀRRAKSTĪTI ar backup.
echo.

where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker nav
  pause
  exit /b 1
)

if not exist "backups" (
  echo ERROR: mape backups\ nav — vispirms BACKUP-DB.bat
  pause
  exit /b 1
)

echo Pieejamie backupi:
echo.
dir /b /o-d "backups\vs-system-db-*.sql" 2>nul
if errorlevel 1 (
  echo ERROR: nav neviena vs-system-db-*.sql
  pause
  exit /b 1
)

echo.
set /p "PICK=Ieraksti faila nosaukumu (vai pilnu celu): "
if "%PICK%"=="" (
  echo Atcelts
  pause
  exit /b 1
)

set "FILE=%PICK%"
if not exist "%FILE%" set "FILE=%~dp0backups\%PICK%"
if not exist "%FILE%" (
  echo ERROR: fails nav atrasts: %FILE%
  pause
  exit /b 1
)

echo.
echo [1/3] Postgres up...
docker compose up -d postgres
timeout /t 5 /nobreak >nul

echo [2/3] Restore %FILE% ...
type "%FILE%" | docker exec -i nexus-postgres psql -U nexus -d nexus_pro
if errorlevel 1 (
  echo ERROR: restore neizdevas
  pause
  exit /b 1
)

echo [3/3] Gatavs.
echo.
echo   Tagad: START-VS-SYSTEM.bat
echo   Login: owner@nexus.pro / NexusOwner123!
echo   Accounts → Connect Capital
echo.
echo   Ja Connect fail: .env ENCRYPTION_KEY jabut TAM PASAM ka backup briidi.
echo ========================================
pause
exit /b 0
