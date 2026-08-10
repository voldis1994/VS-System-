@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title VS System — DIAGNOSE DB
echo ========================================
echo   DB / volume / backup diagnostika
echo   ^(neko nemaina — tikai rāda^)
echo ========================================
echo.

where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker nav
  pause
  exit /b 1
)

echo --- docker volumes ---
docker volume ls
echo.

echo --- target vs-system_nexus_pg ---
docker volume inspect vs-system_nexus_pg 2>nul
if errorlevel 1 echo   NAV

echo.
echo --- live TradingAccount count ---
docker exec nexus-postgres psql -U nexus -d nexus_pro -c "SELECT count(*) AS accounts FROM \"TradingAccount\";" 2>nul
if errorlevel 1 echo   Postgres nav skrienos / tabula nav

echo.
echo --- Organization / User ---
docker exec nexus-postgres psql -U nexus -d nexus_pro -c "SELECT id, slug, name FROM \"Organization\";" 2>nul
docker exec nexus-postgres psql -U nexus -d nexus_pro -c "SELECT email FROM \"User\";" 2>nul

echo.
echo --- backups\ ---
if exist "backups" (
  dir /o-d "backups\*.sql"
) else (
  echo   mape backups\ nav
)

echo.
echo --- .env ENCRYPTION_KEY ^(pirmais/pedejais 8^) ---
if exist ".env" (
  for /f "tokens=1,* delims==" %%A in ('findstr /B "ENCRYPTION_KEY=" .env') do (
    set "K=%%B"
  )
)
if defined K (
  echo   key len + prefix: 
  powershell -NoProfile -Command "$k=$env:K; if(-not $k){$k=(Select-String -Path .env -Pattern '^ENCRYPTION_KEY=').Line -replace '^ENCRYPTION_KEY=',''; Write-Host ('  len=' + $k.Length + '  ' + $k.Substring(0,[Math]::Min(8,$k.Length)) + '...' + $k.Substring([Math]::Max(0,$k.Length-8)))"
) else (
  echo   .env nav ENCRYPTION_KEY
)

echo.
echo Ja accounts=0: palaid RECOVER-ACCOUNTS.bat
echo Ja recover ari 0: Accounts → pievieno Capital API no jauna
echo ========================================
pause
exit /b 0
