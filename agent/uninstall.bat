@echo off
setlocal enabledelayedexpansion

echo ========================================
echo  Windows Employee Monitor - Uninstaller
echo ========================================
echo.

:: Check for admin rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: This must be run as Administrator
    echo Right-click and select "Run as administrator"
    echo.
    pause
    exit /b 1
)

set INSTALL_DIR=%APPDATA%\Microsoft\Windows\MonitorAgent

echo [1/5] Stopping monitoring service...
cd /d "%INSTALL_DIR%" 2>nul
node install-service.js --stop 2>nul
timeout /t 2 /nobreak >nul
echo       Service stopped

echo [2/5] Uninstalling Windows service...
cd /d "%INSTALL_DIR%" 2>nul
node install-service.js --uninstall 2>nul
echo       Service removed

echo [3/5] Removing auto-start entries...
:: Remove from Registry
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "SysMonAgent" /f >nul 2>&1
:: Remove from Startup folder
del /f /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SysMonAgent.vbs" >nul 2>&1
echo       Auto-start removed

echo [4/5] Removing agent files...
cd /d "%APPDATA%"
rmdir /s /q "%INSTALL_DIR%" 2>nul
if exist "%INSTALL_DIR%" (
    echo       WARNING: Some files could not be removed
    echo       Manual cleanup may be needed: %INSTALL_DIR%
) else (
    echo       Files removed
)

echo [5/5] Cleaning up temporary files...
del /f /q "%TEMP%\*_history_temp.db" >nul 2>&1
echo       Cleanup complete

echo.
echo ========================================
echo  UNINSTALL COMPLETE
echo ========================================
echo.
echo  The monitoring agent has been:
echo  - Service stopped and removed
echo  - Auto-start entries removed
echo  - Agent files deleted
echo.
echo  No data will be collected from this PC.
echo  Dashboard will no longer receive updates from this machine.
echo ========================================
echo.
pause
