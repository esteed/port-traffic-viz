@echo off
rem Simulated traffic, no administrator rights needed. Close this window to stop.
py -3 "%~dp0server.py" --demo %*
if errorlevel 1 pause
