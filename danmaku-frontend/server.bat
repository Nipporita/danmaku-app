@echo off
REM 切换到 bat 文件所在目录
cd /d %~dp0

REM 启动本地服务器 (Python3)
python -m http.server 1919

pause