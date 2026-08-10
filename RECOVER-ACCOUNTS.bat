@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

title VS System — RECOVER ACCOUNTS
echo ========================================
echo   ATJAUNO KONTUS ^(Docker volume / backup^)
echo   Es NEIZDZEŠU Capital — konti bija
echo   lokala Postgres volume. Tagad atrodam.
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

echo [1/5] Apturu konteinerus ^(lai volume var kopet^)...
docker compose stop >nul 2>&1
docker stop nexus-postgres >nul 2>&1
timeout /t 2 /nobreak >nul

set "TARGET=vs-system_nexus_pg"
echo.
echo [2/5] Mekleju vecos volumes...
echo.
docker volume ls --format "{{.Name}}"
echo.

set "CANDIDATES="
set "COUNT=0"
for /f "delims=" %%V in ('docker volume ls -q') do (
  set "VN=%%V"
  if /I not "!VN!"=="%TARGET%" (
    echo !VN! | findstr /I /C:"nexus_pg" /C:"vs-system" /C:"postgres" /C:"workspace_" >nul
    if not errorlevel 1 (
      set /a COUNT+=1
      set "CAND!COUNT!=!VN!"
      for /f "tokens=*" %%S in ('docker run --rm -v !VN!:/data alpine sh -c "du -sk /data 2>/dev/null | cut -f1" 2^>nul') do set "SZ!COUNT!=%%S"
      if not defined SZ!COUNT! set "SZ!COUNT!=0"
      echo   kandidats !COUNT!: !VN!   (~!SZ!COUNT! KB)
    )
  )
)

echo.
if "%COUNT%"=="0" (
  echo Nav atrasts vecs volume ar nexus/vs-system nosaukumu.
  echo.
  goto TRY_SQL
)

REM Pick largest candidate by KB
set "BEST=1"
set "BESTSZ=0"
for /L %%I in (1,1,%COUNT%) do (
  set /a CUR=!SZ%%I! 2>nul
  if !CUR! GTR !BESTSZ! (
    set "BESTSZ=!CUR!"
    set "BEST=%%I"
  )
)
set "OLD=!CAND%BEST%!"
echo Lielakais kandidats: %OLD%  (~%BESTSZ% KB)
echo.
if %BESTSZ% LSS 100 (
  echo Volume izskatas tukss — mekleju SQL backup...
  goto TRY_SQL
)

if %COUNT% GTR 1 (
  echo Vairaki volumes. Enter = lietot lielako [%OLD%]
  set /p "PICK=Vai ieraksti numuru 1-%COUNT%: "
  if not "!PICK!"=="" (
    set "OLD=!CAND%PICK%!"
    if "!OLD!"=="" (
      echo Nepareizs numurs
      pause
      exit /b 1
    )
  )
)

echo.
echo [3/5] Kopeju %OLD%  →  %TARGET%
echo   ^(esošie tukšie dati targeta tiks aizvietoti^)
echo.

docker volume inspect %TARGET% >nul 2>&1
if errorlevel 1 (
  echo   Veidoju %TARGET%...
  docker volume create %TARGET% >nul
)

docker run --rm -v %OLD%:/from -v %TARGET%:/to alpine sh -c "cd /to && rm -rf ./* ./.[!.]* 2>/dev/null; cp -a /from/. /to/ && du -sk /to"
if errorlevel 1 (
  echo ERROR: kopēšana neizdevas
  pause
  exit /b 1
)

echo.
echo [4/5] Palaižu Postgres...
docker compose up -d postgres
timeout /t 8 /nobreak >nul

echo [5/5] Parbaudu TradingAccount tabulu...
docker exec nexus-postgres psql -U nexus -d nexus_pro -tAc "SELECT count(*) FROM \"TradingAccount\";" 2>nul
if errorlevel 1 (
  echo WARNING: DB vel startējas vai schema cita — START-VS-SYSTEM.bat tomer.
) else (
  echo   OK — kontu skaits augstak.
)

echo.
echo ========================================
echo   GATACS. Tagad:
echo     1^) START-VS-SYSTEM.bat
echo     2^) Login owner@nexus.pro / NexusOwner123!
echo     3^) Accounts → Connect
echo.
echo   Ja Connect fail: .env ENCRYPTION_KEY jabut
echo   TAM PASAM ka briidi kad kontus pievienoji.
echo ========================================
pause
exit /b 0

:TRY_SQL
echo [SQL] Mekleju backups\ ...
if not exist "backups" (
  echo ERROR: nav volume UN nav backups\
  echo.
  echo Konti bija TIKAI tava PC Docker. Cloud tos neglabaja.
  echo Atjauno: Accounts → Add Capital ^(API key + password + email^)
  echo ar TO PASU .env ENCRYPTION_KEY.
  pause
  exit /b 1
)

echo Pieejamie:
dir /b /o-d "backups\*.sql" 2>nul
echo.
set "LATEST="
for /f "delims=" %%F in ('dir /b /o-d "backups\*.sql" 2^>nul') do (
  if not defined LATEST set "LATEST=%%F"
)
if not defined LATEST (
  echo ERROR: nav .sql backupu
  echo Atjauno manuāli: Accounts → pievieno Capital no jauna.
  pause
  exit /b 1
)

echo Lietosiu jaunako: backups\%LATEST%
echo Enter = OK, vai ieraksti citu faila nosaukumu:
set /p "SPICK= "
if not "%SPICK%"=="" set "LATEST=%SPICK%"
set "FILE=%~dp0backups\%LATEST%"
if not exist "%FILE%" set "FILE=%LATEST%"
if not exist "%FILE%" (
  echo ERROR: fails nav: %FILE%
  pause
  exit /b 1
)

echo.
echo Restore no %FILE% ...
docker compose up -d postgres
timeout /t 8 /nobreak >nul
type "%FILE%" | docker exec -i nexus-postgres psql -U nexus -d nexus_pro
if errorlevel 1 (
  echo ERROR: SQL restore neizdevas
  pause
  exit /b 1
)

echo.
echo OK. Palaid START-VS-SYSTEM.bat
pause
exit /b 0
