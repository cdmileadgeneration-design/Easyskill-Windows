@echo off
setlocal
title Easyskill Monitor - Uninstaller

echo ========================================
echo  Windows Employee Monitor - Uninstaller
echo ========================================
echo.

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This must be run as Administrator
    echo Right-click ^> Run as administrator
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" -Uninstall
set "RC=%errorLevel%"

echo.
pause
exit /b %RC%
