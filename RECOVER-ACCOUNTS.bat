@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title VS System — RECOVER ACCOUNTS
echo.
echo   Palaizu PowerShell probe ^(visi volumes + SQL^)...
echo.

where powershell >nul 2>&1
if errorlevel 1 (
  echo ERROR: PowerShell nav — nepieciesams Windows.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0RECOVER-ACCOUNTS.ps1"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo RECOVER OK — palaid START-VS-SYSTEM.bat
) else if "%RC%"=="2" (
  echo RECOVER: veca DB nav — pievieno Capital no jauna Accounts lapā.
) else if "%RC%"=="3" (
  echo RECOVER: restore mēģināts, bet joprojām 0 konti.
) else (
  echo RECOVER exit=%RC%
)
echo.
pause
exit /b %RC%
