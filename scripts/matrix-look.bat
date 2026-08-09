@echo off
REM Visual-only Matrix rain (same window). Never runs workers / never redirects output.
setlocal EnableExtensions
color 0A
chcp 65001 >nul 2>&1
where powershell >nul 2>&1
if errorlevel 1 exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0matrix-look.ps1" -Seconds 3
color 0A
exit /b 0
