@echo off
setlocal
cd /d "%~dp0"
node -e "require('node:sqlite')" >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js 22.13 or newer.
  pause
  exit /b 1
)
start "WMPVP" /min node listen.mjs --open
