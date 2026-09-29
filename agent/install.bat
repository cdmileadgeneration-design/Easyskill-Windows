@echo off
setlocal
title Easyskill Monitor - Installer

echo ========================================
echo  Windows Employee Monitor - Installer
echo ========================================
echo.
echo  This will:
echo   - Install the agent to %%ProgramData%%\EasyskillMonitor
echo   - Register boot + logon startup (survives reboot)
echo   - Register a watchdog that restarts it if it is killed
echo   - Lock the folder so the logged-in user cannot remove it
echo   - Ask you to set an uninstall password (keep it safe!)
echo   - Start it now and verify it is reporting
echo.

:: Check for admin rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This must be run as Administrator
    echo Right-click ^> Run as administrator
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
set "RC=%errorLevel%"

echo.
if "%RC%"=="0" (
    echo  Install finished. Open deploy.ps1 -Status to check it any time.
) else (
    echo  Install reported an error - see the output above.
)
echo.
pause
exit /b %RC%
