@echo off
cd /d "%~dp0"
echo Stopping NEXUS containers...
docker compose stop postgres redis 2>nul
echo Done. API/Web logus aizver ar X vai Ctrl+C.
pause
