@echo off
REM jump to this script's directory
cd /d %~dp0

REM start dev server on port 1919 (no-cache + auto reload on file change)
python dev_server.py 1919

pause
