@echo off
REM Shared Matrix splash for VS System bats. Args: label text
setlocal EnableExtensions
color 0A
chcp 65001 >nul 2>&1
where powershell >nul 2>&1
if errorlevel 1 (
  echo.
  echo   VS SYSTEM — %~1
  echo.
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0matrix-boot.ps1" -Label "%~1"
exit /b 0
