@echo off
rem Runs SV Studio with a console window so you can see its log output.
cd /d "%~dp0"
where py >nul 2>nul && (py -3 "%~dp0svstudio.py" %*) || (python "%~dp0svstudio.py" %*)
pause
