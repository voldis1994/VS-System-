@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title VS System — START
echo ========================================
echo   VS SYSTEM — pilna palaide
echo   API + Web + DB  (stabils LAN /client)
echo ========================================
echo.

if exist "VERSION.txt" (
  echo Versija no pedeja UPDATE:
  type "VERSION.txt"
  echo.
) else if exist ".git" (
  for /f "delims=" %%h in ('git rev-parse --short HEAD 2^>nul') do echo Git commit: %%h
  echo.
)

if exist "apps\api-desktop" (
  echo WARNING: atrasta mape apps\api-desktop
  echo   Pareiza mape: apps\api  — aizver api-desktop procesu!
  echo.
)

where git >nul 2>&1
if not errorlevel 1 (
  if exist ".git" (
    for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "VS_BRANCH=%%b"
    if /I "%VS_BRANCH%"=="main" (
      echo [0/7] sync origin/main ^(fetch + reset --hard^)...
      git fetch origin main
      if not errorlevel 1 (
        git reset --hard origin/main
        for /f "delims=" %%h in ('git rev-parse --short HEAD 2^>nul') do (
          echo   commit = %%h
          > "%~dp0VERSION.txt" echo commit=%%h
        )
      ) else (
        echo WARNING: git fetch neizdevas — turpinu ar lokalo
      )
    ) else (
      echo [0/7] skip sync — branch=%VS_BRANCH% ^(vajag main^)
    )
  ) else (
    echo WARNING: nav .git — START nevelk update. Izmanto git clone + FORCE-UPDATE.
  )
)

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js nav atrasts — https://nodejs.org
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
  echo ERROR: Docker nav atrasts — palaid Docker Desktop
  pause
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker Engine nestrada — pagaidi lidz Engine running
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
)

echo.
echo [1/7] pnpm install...
call pnpm install
if errorlevel 1 (
  echo ERROR: pnpm install neizdevas
  pause
  exit /b 1
)

echo.
echo [2/7] Building packages...
call pnpm --filter @nexus/domain build
if errorlevel 1 goto :build_fail
call pnpm --filter @nexus/shared build
if errorlevel 1 goto :build_fail
call pnpm --filter @nexus/config build
if errorlevel 1 goto :build_fail
call pnpm --filter @nexus/broker-adapters build
if errorlevel 1 goto :build_fail

echo.
echo [3/7] Postgres + Redis...
docker compose up -d postgres redis
if errorlevel 1 (
  echo ERROR: docker compose neizdevas
  pause
  exit /b 1
)
echo Waiting for Postgres...
timeout /t 8 /nobreak >nul

echo.
echo [4/7] Prisma generate + migrate...
call pnpm db:generate
if errorlevel 1 (
  echo ERROR: prisma generate neizdevas
  pause
  exit /b 1
)
call pnpm --filter @nexus/api exec prisma migrate deploy
if errorlevel 1 (
  echo ERROR: migrate neizdevas
  pause
  exit /b 1
)

echo.
echo [5/7] Seed...
call pnpm db:seed
if errorlevel 1 echo WARNING: seed neizdevas — varbut jau seeded

echo.
echo [6/7] API + Web (ports 4000 / 3000)...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4000 " ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
timeout /t 2 /nobreak >nul

if not exist "apps\api\.env" copy /Y .env apps\api\.env >nul
start "VS System API" cmd /k "cd /d "%~dp0" && pnpm dev:api"
timeout /t 4 /nobreak >nul
start "VS System WEB" cmd /k "cd /d "%~dp0" && pnpm dev:web"
timeout /t 10 /nobreak >nul

echo.
echo [Firewall] LAN porti 3000 + 4000...
netsh advfirewall firewall delete rule name="VS System Web 3000" >nul 2>&1
netsh advfirewall firewall delete rule name="VS System API 4000" >nul 2>&1
netsh advfirewall firewall add rule name="VS System Web 3000" dir=in action=allow protocol=TCP localport=3000 >nul
netsh advfirewall firewall add rule name="VS System API 4000" dir=in action=allow protocol=TCP localport=4000 >nul

echo.
echo [7/7] Stabilais client URL (VIENA adrese — LAN)...
> "%~dp0client-url.txt" echo.
set "VS_LAN="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=1" %%b in ("%%a") do (
    if not defined VS_LAN set "VS_LAN=%%b"
    >> "%~dp0client-url.txt" echo http://%%b:3000/client
  )
)
if defined VS_LAN (
  echo   http://%VS_LAN%:3000/client
) else (
  echo   http://localhost:3000/client
  >> "%~dp0client-url.txt" echo http://localhost:3000/client
)
echo   Saglabats: client-url.txt
echo.
echo   Remote (cita Wi-Fi / 4G)? Palaid ATSEVISKI:
echo     START-REMOTE-TUNNEL.bat
echo   ^(brivais Cloudflare katru reizi dod JAUNU linku — tapec nav START^)

timeout /t 2 /nobreak >nul
start "" http://localhost:3000/dashboard

echo.
echo ========================================
echo   VS SYSTEM SKRIEN
echo.
echo   DESK (tev uz PC) — VIENMER tapat:
echo     http://localhost:3000/dashboard
echo     http://localhost:3000/strategies
echo     API health: http://localhost:4000/api/health
echo.
echo   KLIENTI — VIENA stabila adrese (LAN /client):
if defined VS_LAN (
  echo     http://%VS_LAN%:3000/client
) else (
  echo     http://localhost:3000/client
)
echo     fails: client-url.txt
echo.
echo   Login: owner@nexus.pro / NexusOwner123!
echo   PIN:   123456
echo.
echo   Apturet:  STOP-VS-SYSTEM.bat
echo   Update:   UPDATE-VS-SYSTEM.bat
echo   Logus NEAIZVER (API / WEB)
echo ========================================
pause
exit /b 0

:build_fail
echo ERROR: package build neizdevas
pause
exit /b 1
