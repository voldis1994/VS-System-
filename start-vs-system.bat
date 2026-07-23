@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ========================================
echo   VS System - Windows start
echo ========================================
echo.

where git >nul 2>&1
if not errorlevel 1 (
  echo [0/6] git pull origin main...
  git pull origin main
  if errorlevel 1 (
    echo WARNING: git pull neizdevas - turpinu ar esošo kodu
  )
)

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js nav atrasts. Uzliec no https://nodejs.org
  pause
  exit /b 1
)

where pnpm >nul 2>&1
if errorlevel 1 (
  echo Installing pnpm...
  call npm install -g pnpm
  if errorlevel 1 (
    echo ERROR: pnpm instalacija neizdevas
    pause
    exit /b 1
  )
)

where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker nav atrasts. Palaid Docker Desktop un megini velreiz.
  pause
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker Engine nestrada. Atver Docker Desktop un pagaidi lidz Engine running.
  pause
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo Created .env
  ) else (
    echo ERROR: .env.example nav atrasts
    pause
    exit /b 1
  )
)

if not exist "apps\api\.env" (
  copy /Y ".env" "apps\api\.env" >nul
  echo Created apps\api\.env
) else (
  copy /Y ".env" "apps\api\.env" >nul
)

echo.
echo [1/6] pnpm install...
call pnpm install
if errorlevel 1 (
  echo ERROR: pnpm install neizdevas
  pause
  exit /b 1
)

echo.
echo [2/6] Building packages...
call pnpm --filter @nexus/domain build
if errorlevel 1 goto :build_fail
call pnpm --filter @nexus/shared build
if errorlevel 1 goto :build_fail
call pnpm --filter @nexus/config build
if errorlevel 1 goto :build_fail
call pnpm --filter @nexus/broker-adapters build
if errorlevel 1 goto :build_fail

echo.
echo [3/6] Starting Postgres + Redis...
docker compose up -d postgres redis
if errorlevel 1 (
  echo ERROR: docker compose neizdevas
  pause
  exit /b 1
)

echo Waiting for Postgres...
timeout /t 8 /nobreak >nul

echo.
echo [4/6] Prisma generate + migrate...
call pnpm db:generate
if errorlevel 1 (
  echo ERROR: prisma generate neizdevas
  pause
  exit /b 1
)

call pnpm --filter @nexus/api exec prisma migrate deploy
if errorlevel 1 (
  echo ERROR: migrate neizdevas. Parbaudi ka Docker Postgres strada.
  pause
  exit /b 1
)

echo.
echo [5/6] Seed database...
call pnpm db:seed
if errorlevel 1 (
  echo WARNING: seed neizdevas - varbut jau ir seeded
)

echo.
echo [6/6] Stopping old API/Web (ports 3000/4000) then starting...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4000 " ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
timeout /t 2 /nobreak >nul

start "VS System API" cmd /k "cd /d "%~dp0" && copy /Y .env apps\api\.env >nul && pnpm dev:api"
timeout /t 3 /nobreak >nul
start "VS System WEB" cmd /k "cd /d "%~dp0" && pnpm dev:web"

timeout /t 8 /nobreak >nul
start "" http://localhost:3000/strategies

echo.
echo ========================================
echo   Gatavs  (build bots-v2)
echo   Strategies: http://localhost:3000/strategies
echo   Dashboard:  http://localhost:3000/dashboard
echo   API: http://localhost:4000/api/health
echo.
echo   Login: owner@nexus.pro
echo   Pass:  NexusOwner123!
echo   PIN:   123456
echo.
echo   Ja Dashboard kreisaja puse NAV "Strategies AUTO" —
echo   vecais process vel skrien. Aizver VISUS CMD un palaid velreiz.
echo ========================================
pause
exit /b 0

:build_fail
echo ERROR: package build neizdevas
pause
exit /b 1
