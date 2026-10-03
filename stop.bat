@echo off
REM ===========================================================================
REM  LeebertyPV - stop a silently started instance
REM
REM  Pure ASCII on purpose: see the long note in start.bat.
REM
REM  Locates the instance by, in order of reliability:
REM    1. the process LISTENING on the target port
REM    2. a node process whose command line contains server.js
REM ===========================================================================
setlocal EnableExtensions EnableDelayedExpansion
title LeebertyPV - stop

cd /d "%~dp0"
set "PV_PORT=8793"
if not "%~1"=="" set "PV_PORT=%~1"

echo.
echo   Looking for LeebertyPV on port %PV_PORT% ...
echo.
set "FOUND=0"

REM ---- method 1: the process listening on the port --------------------------
for /f "tokens=5" %%P in ('netstat -ano -p TCP ^| findstr /r /c:"LISTENING" ^| findstr /c:":%PV_PORT% "') do (
  set "TPID=%%P"
  if not "!TPID!"=="0" (
    echo   Stopping PID !TPID!  ^(port %PV_PORT%^)
    taskkill /PID !TPID! /T /F >nul 2>&1
    if not errorlevel 1 set "FOUND=1"
  )
)

REM ---- method 2: a node process running server.js ---------------------------
if "%FOUND%"=="0" (
  for /f "usebackq tokens=2 delims=," %%P in (`tasklist /fi "imagename eq node.exe" /fo csv /nh 2^>nul`) do (
    set "CAND=%%~P"
    if not "!CAND!"=="0" (
      for /f "delims=" %%C in ('powershell -NoProfile -Command "try { (Get-CimInstance Win32_Process -Filter \"ProcessId=!CAND!\").CommandLine } catch { '' }" 2^>nul') do (
        echo %%C | findstr /i /c:"server.js" >nul 2>&1
        if not errorlevel 1 (
          echo   Stopping PID !CAND!
          taskkill /PID !CAND! /T /F >nul 2>&1
          if not errorlevel 1 set "FOUND=1"
        )
      )
    )
  )
)

if "%FOUND%"=="0" (
  echo   No running instance was found.
  echo.
  echo   Note: if you started it with start.bat, just close its console window.
) else (
  echo.
  echo   Stopped. Data has been flushed to disk.
  echo.
  echo   Verifying the audit trail afterwards is good practice:
  echo     node scripts\verify-audit.js
)

echo.
pause
endlocal