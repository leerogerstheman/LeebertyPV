@echo off
REM ===========================================================================
REM  LeebertyPV - generate the demonstration dataset
REM
REM  Pure ASCII on purpose: see the long note in start.bat. cmd.exe reads .bat
REM  files using the active console code page, so keeping this file ASCII makes
REM  it immune to the code page. Do NOT add non-ASCII text here.
REM
REM  WARNING: this writes FICTIONAL safety records into the live audit trail.
REM  Never run it against a production instance.
REM ===========================================================================
setlocal EnableExtensions
title LeebertyPV - demo data
cd /d "%~dp0"
chcp 65001 >nul 2>&1

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
  echo   [ERROR] Node.js not found. Install Node.js 22.5+ from https://nodejs.org
  pause
  exit /b 1
)

echo.
echo   ============================================================
echo    LeebertyPV - generate demonstration data
echo   ============================================================
echo.
echo   This creates FICTIONAL safety records: ICSR cases, signals,
echo   PSUR, RMP, AEFI, deviations, CAPAs, signatures and training.
echo.
echo   Do NOT run this against a production instance.
echo.
choice /c YN /n /m "  Continue? [Y/N] "
if errorlevel 2 exit /b 0
echo.

"%NODE_EXE%" "scripts\seed-demo.js" %*

set "EXITCODE=%ERRORLEVEL%"
echo.
if "%EXITCODE%"=="0" (
  echo   Done. Start the workbench with start.bat and sign in with
  echo   one of the demo accounts using the password shown above.
) else (
  echo   [ERROR] The demo dataset was not generated ^(exit code %EXITCODE%^).
  echo.
  echo   If the message says an administrator account is required, start the
  echo   workbench with start.bat and complete the first-run setup first.
)
echo.
pause
endlocal