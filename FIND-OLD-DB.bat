@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title VS System — FIND OLD DB
echo ========================================
echo   Mekle veco Postgres volume
echo   ^(konti pazud pec mapes maiņas^)
echo ========================================
echo.

where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker nav
  pause
  exit /b 1
)

echo Docker volumes ar "nexus" / "vs-system" / "postgres":
echo.
docker volume ls
echo.
echo Tipiski vecie nosaukumi:
echo   vs-system_nexus_pg          ^(jaunais stabilais^)
echo   vs-system-_nexus_pg
echo   vs-system-main_nexus_pg
echo   workspace_nexus_pg
echo.

echo Aktiva volume (compose): vs-system_nexus_pg
docker volume inspect vs-system_nexus_pg >nul 2>&1
if errorlevel 1 (
  echo   vs-system_nexus_pg VEL NAV — pirmais START izveidos tuksu.
) else (
  echo   vs-system_nexus_pg PASTAV.
)

echo.
echo VIENKARSI: palaid RECOVER-ACCOUNTS.bat
echo   ^(automātiski atrod veco volume un ieliek atpakaļ^)
echo.
echo Manuāli:
echo   1^) STOP-VS-SYSTEM.bat
echo   2^) Atrodi VECU volume no saraksta augša
echo   3^) Palaid ^(aizvieto OLD_VOLUME^):
echo.
echo docker run --rm -v OLD_VOLUME:/from -v vs-system_nexus_pg:/to alpine sh -c "cd /to ^&^& rm -rf ./* ./.[!.]* 2^>/dev/null; cp -a /from/. /to/"
echo.
echo   4^) START-VS-SYSTEM.bat
echo.
echo Capital API atslegas es NEGLABĀJU cloud — tikai tava DB.
echo Ja volume zudis: Accounts → pievieno Capital no jauna.
echo ========================================
pause
exit /b 0
