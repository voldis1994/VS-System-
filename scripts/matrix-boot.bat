@echo off
REM Launch real Matrix rain host. Args: "StayOpen" optional as %2
setlocal EnableExtensions
color 0A
chcp 65001 >nul 2>&1
where powershell >nul 2>&1
if errorlevel 1 exit /b 1

set "STAY="
if /I "%~2"=="StayOpen" set "STAY=-StayOpen"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0matrix-rain.ps1" -Worker "%~1" -WorkerArg "--worker" -MinSeconds 2 %STAY%
exit /b %ERRORLEVEL%
