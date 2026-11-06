@echo off
rem Builds dist\PortTraffic.exe. Needs Python 3.10+ (64-bit), and internet the first time.
rem The build tools live in %LOCALAPPDATA%\PortTrafficViz\build, outside Google Drive.
setlocal
set "ENV=%LOCALAPPDATA%\PortTrafficViz\build\venv"
if not exist "%ENV%\Scripts\python.exe" (
  echo Setting up build tools in %ENV% ...
  py -3.12 -m venv "%ENV%" 2>nul || py -3 -m venv "%ENV%" || goto :fail
)
"%ENV%\Scripts\python.exe" -m pip install --disable-pip-version-check -q pywebview pyinstaller pillow || goto :fail
"%ENV%\Scripts\python.exe" "%~dp0build.py" || goto :fail
echo.
echo Built "%~dp0dist\PortTraffic.exe"
pause
exit /b 0

:fail
echo.
echo Build failed.
pause
exit /b 1
