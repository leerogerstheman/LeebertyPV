@echo off
REM ===========================================================================
REM  LeebertyPV - silent launcher (no console window)
REM
REM  Pure ASCII on purpose: see the long note in start.bat. cmd.exe reads .bat
REM  files using the active code page, so keeping this file ASCII makes it
REM  immune to the console code page. Do NOT add non-ASCII text here.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

set "PV_PORT=8793"
if not "%~1"=="" set "PV_PORT=%~1"

set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE (
  for %%P in (
    "%ProgramFiles%\nodejs\node.exe"
    "%ProgramFiles(x86)%\nodejs\node.exe"
    "%LOCALAPPDATA%\Programs\nodejs\node.exe"
    "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  ) do (
    if not defined NODE_EXE if exist %%P set "NODE_EXE=%%~P"
  )
)

if not defined NODE_EXE (
  echo Node.js not found. Install Node.js 22.5+ from https://nodejs.org
  pause
  exit /b 1
)

if not exist "data" mkdir "data" >nul 2>&1
if not exist "logs" mkdir "logs" >nul 2>&1

echo Starting LeebertyPV in the background on port %PV_PORT% ...
start "LeebertyPV" /min cmd /c ""%NODE_EXE%" "src\server.js" >> "logs\server.log" 2>&1"

REM Wait for the server to answer before opening the browser, so the user does
REM not land on a connection error and conclude the app is broken.
set /a TRIES=0
:waitloop
set /a TRIES+=1
timeout /t 1 /nobreak >nul 2>&1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:%PV_PORT%/api/health' -TimeoutSec 2 -UseBasicParsing; if ($r.StatusCode -ge 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto ready
if %TRIES% lss 25 goto waitloop

echo.
echo The server did not respond within 25 seconds.
echo Check logs\server.log, or run start.bat to see the output directly.
echo.
pause
exit /b 1

:ready
if exist "%~dp0LeebertyPV.exe" (
  start "" "%~dp0LeebertyPV.exe" --port %PV_PORT% >nul 2>&1
) else (
  start "" "http://127.0.0.1:%PV_PORT%"
)
echo.
echo   Running at http://127.0.0.1:%PV_PORT%
echo   Log file: logs\server.log
echo   To stop:  stop.bat
echo.
timeout /t 4 /nobreak >nul 2>&1
endlocal