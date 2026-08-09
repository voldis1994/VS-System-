@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title VS System — FORCE UPDATE
echo ========================================
echo   VS SYSTEM — SPIEDIGS atjauninajums
echo   git reset --hard origin/main
echo ========================================
echo.
echo Mapes cels: %CD%
echo.
echo SVARIGI: so mapi aizver STOP-VS-SYSTEM.bat pirms UPDATE.
echo   Lokālas necommitotas izmainas TIKS IZDZESTAS.
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: Git nav atrasts — https://git-scm.com/download/win
  pause
  exit /b 1
)

if not exist ".git" (
  echo ERROR: si mape NAV git clone.
  echo   ZIP lejupielade NESTRADA ar UPDATE.
  echo   Dari VIENU REIZI:
  echo     cd Desktop
  echo     git clone https://github.com/voldis1994/VS-System-.git
  echo   Tad strādā no VS-System- mapes ar so UPDATE.
  pause
  exit /b 1
)

for /f "delims=" %%h in ('git rev-parse --short HEAD 2^>nul') do set "VS_BEFORE=%%h"
echo [1/5] Pirms: %VS_BEFORE%

echo [2/5] checkout main...
git checkout main
if errorlevel 1 (
  echo ERROR: checkout main neizdevas — aizver editorus / STOP
  pause
  exit /b 1
)

echo [3/5] fetch origin main...
git fetch origin main
if errorlevel 1 (
  echo ERROR: fetch neizdevas — internets / GitHub
  pause
  exit /b 1
)

echo [4/5] reset --hard origin/main  ^(piespiedu^)...
git reset --hard origin/main
if errorlevel 1 (
  echo ERROR: reset neizdevas
  pause
  exit /b 1
)
git clean -fd -e tools -e node_modules -e .env -e "apps\api\.env" -e client-url.txt -e remote-client-url.txt >nul 2>&1

for /f "delims=" %%h in ('git rev-parse --short HEAD 2^>nul') do set "VS_AFTER=%%h"
for /f "delims=" %%f in ('git rev-parse HEAD 2^>nul') do set "VS_FULL=%%f"
for /f "delims=" %%d in ('git log -1 --format^=%%ci 2^>nul') do set "VS_DATE=%%d"

> "%~dp0VERSION.txt" (
  echo commit=%VS_AFTER%
  echo full=%VS_FULL%
  echo date=%VS_DATE%
  echo branch=main
  echo remote=origin/main
)

echo.
echo   TAGAD IR: %VS_AFTER%
echo   Gaiditais jaunakais: b8ad46a  ^(vai jaunaks^)
echo   VERSION.txt uzrakstits.
echo.

echo [5/5] pnpm install + package build...
where pnpm >nul 2>&1
if errorlevel 1 (
  where npm >nul 2>&1
  if not errorlevel 1 call npm install -g pnpm
)
where pnpm >nul 2>&1
if not errorlevel 1 (
  call pnpm install
  call pnpm --filter @nexus/domain build
  call pnpm --filter @nexus/shared build
  call pnpm --filter @nexus/broker-adapters build
  call pnpm --filter @nexus/config build
) else (
  echo WARNING: pnpm nav — START uzinstalēs
)

echo.
echo ========================================
echo   UPDATE GATAVS — commit %VS_AFTER%
echo.
echo   1^) START-VS-SYSTEM.bat
echo   2^) Telefonā: Safari refresh / clear cache uz /client
echo   3^) SAVE → START
echo.
echo   Ja commit joprojam vecs — tu esi nepareizaja mapē
echo   ^(nevis git clone VS-System-^).
echo ========================================
pause
exit /b 0
