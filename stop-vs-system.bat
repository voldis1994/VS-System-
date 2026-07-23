@echo off
cd /d "%~dp0"
echo Stopping VS System containers...
docker compose stop postgres redis 2>nul
echo Done. API/Web logus aizver ar X vai Ctrl+C.
pause
