@echo off
rem SV Studio launcher for Windows - starts without a console window.
cd /d "%~dp0"
where pyw >nul 2>nul && (start "" pyw -3 "%~dp0svstudio.py" %* & exit /b)
where pythonw >nul 2>nul && (start "" pythonw "%~dp0svstudio.py" %* & exit /b)
where python >nul 2>nul && (python "%~dp0svstudio.py" %* & exit /b)
echo Python 3 was not found. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH").
pause
