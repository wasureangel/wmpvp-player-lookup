@echo off
cd /d "%~dp0"
if exist "%~dp0runtime\pythonw.exe" (
    start "" "%~dp0runtime\pythonw.exe" -X utf8 "%~dp0web_app.py" --open
    exit /b
)
where pyw >nul 2>&1
if not errorlevel 1 (
    start "" pyw -3 -X utf8 "%~dp0web_app.py" --open
    exit /b
)
where pythonw >nul 2>&1
if not errorlevel 1 (
    start "" pythonw -X utf8 "%~dp0web_app.py" --open
    exit /b
)
echo Python 3.10 or newer is required. Install Python, then run this file again.
echo You can also run: python web_app.py --open
pause
