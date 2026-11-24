@echo off
cd /d "%~dp0earth_moon_viewer"
call .venv\Scripts\activate.bat
python app.py
pause
