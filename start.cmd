@echo off
rem Live capture. Windows asks for administrator rights, which ETW needs;
rem the capture server then runs in its own window and the browser opens here.
py -3 "%~dp0server.py" %*
if errorlevel 1 pause
