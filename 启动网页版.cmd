@echo off
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\pythonw.exe" goto checkenv
if exist "runtime\python.exe" (
    "runtime\python.exe" -c "import httpx" >nul 2>&1
    if not errorlevel 1 (
        start "" "runtime\pythonw.exe" -X utf8 "web_app.py" --open
        exit /b
    )
)
py -3 -c "import sys; assert sys.version_info >= (3,10)" >nul 2>&1
if not errorlevel 1 (
    py -3 -m venv .venv
) else (
    python -c "import sys; assert sys.version_info >= (3,10)" >nul 2>&1
    if errorlevel 1 goto failed
    python -m venv .venv
)
if errorlevel 1 goto failed
:checkenv
".venv\Scripts\python.exe" -c "import httpx" >nul 2>&1
if errorlevel 1 (
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 goto failed
)
start "" ".venv\Scripts\pythonw.exe" -X utf8 "web_app.py" --open
exit /b
:failed
echo Setup failed. Install Python 3.10 or newer and check access to PyPI.
pause
exit /b 1
