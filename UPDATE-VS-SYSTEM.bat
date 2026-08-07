@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title VS System — UPDATE
echo ========================================
echo   VS SYSTEM — atjauninajums no GitHub
echo   Velk jaunako main (merge) so mapa
echo ========================================
echo.
echo Mapes cels: %CD%
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: Git nav atrasts.
  echo   Instalē: https://git-scm.com/download/win
  echo   Tad palaid so failu no VS-System_ mapes (ne ZIP kopijas).
  pause
  exit /b 1
)

if not exist ".git" (
  echo ERROR: si mape NAV git repo.
  echo   Pareizi: clone no GitHub vienu reizi, tad tikai so UPDATE.
  echo   Piemers:
  echo     git clone https://github.com/voldis1994/VS-System_.git
  echo   Pec tam vienmer dublklikski UPDATE-VS-SYSTEM.bat — NAV jaunas mapes.
  pause
  exit /b 1
)

echo [1/4] Pasreizejais branch / commits...
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "VS_BRANCH=%%b"
for /f "delims=" %%h in ('git rev-parse --short HEAD 2^>nul') do set "VS_BEFORE=%%h"
echo   branch = %VS_BRANCH%
echo   commit = %VS_BEFORE%
echo.

if /I not "%VS_BRANCH%"=="main" (
  echo [2/4] Parsledzos uz main...
  git checkout main
  if errorlevel 1 (
    echo ERROR: nevar checkout main — aizver editorus / STOP-VS-SYSTEM.bat
    pause
    exit /b 1
  )
) else (
  echo [2/4] Jau uz main — OK
)

echo.
echo [3/4] git fetch + pull origin main...
git fetch origin main
if errorlevel 1 (
  echo ERROR: git fetch neizdevas — parbaudi internetu / GitHub pieeju
  pause
  exit /b 1
)

git pull --ff-only origin main
if errorlevel 1 (
  echo.
  echo WARNING: ff-only pull neizdevas (lokālas izmainas?).
  echo   Meģinu: git reset --hard origin/main
  echo   ^(!^) Tas izdzes lokālas necommitotas izmainas so mapē.
  choice /C YN /M "Vai reset hard uz origin/main"
  if errorlevel 2 (
    echo Atcelts — nekas nav mainits.
    pause
    exit /b 1
  )
  git reset --hard origin/main
  if errorlevel 1 (
    echo ERROR: reset neizdevas
    pause
    exit /b 1
  )
)

for /f "delims=" %%h in ('git rev-parse --short HEAD 2^>nul') do set "VS_AFTER=%%h"
echo.
echo [4/4] Dependencies (pnpm^)...
where pnpm >nul 2>&1
if errorlevel 1 (
  where npm >nul 2>&1
  if not errorlevel 1 (
    echo   Instalēju pnpm...
    call npm install -g pnpm
  )
)
where pnpm >nul 2>&1
if not errorlevel 1 (
  call pnpm install
  if errorlevel 1 echo WARNING: pnpm install neizdevas — START mēģinās vēlreiz
) else (
  echo   pnpm nav — izlaizu; START-VS-SYSTEM.bat uzinstalēs
)

echo.
echo ========================================
echo   GATAVS
if /I "%VS_BEFORE%"=="%VS_AFTER%" (
  echo   Jau bija jaunakais: %VS_AFTER%
) else (
  echo   Atjauninats: %VS_BEFORE%  -^>  %VS_AFTER%
)
echo.
echo   Tagad: START-VS-SYSTEM.bat
echo   Apturet: STOP-VS-SYSTEM.bat
echo ========================================
echo.
pause
exit /b 0
