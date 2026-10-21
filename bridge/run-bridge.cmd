@echo off
setlocal
cd /d "%~dp0.."
set "PY=C:\Users\yyoung\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
set "SITE=%USERPROFILE%\.onepage-agent\venv\Lib\site-packages"
set "MODEL=%USERPROFILE%\.onepage-agent\models"
set "LOG=%~dp0bridge.log"
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
"%PY%" -c "import sys, runpy; sys.path.insert(0, r'%SITE%'); sys.argv=['server.py','8765']; runpy.run_path(r'%~dp0server.py', run_name='__main__')" >> "%LOG%" 2>&1
