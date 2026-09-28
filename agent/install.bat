@echo off
setlocal enabledelayedexpansion

echo ========================================
echo  Windows Employee Monitor - Installer
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
set SCRIPT_DIR=%~dp0

echo [1/6] Creating installation directory...
if not exist "%INSTALL_DIR%" (
    mkdir "%INSTALL_DIR%"
    echo       Created: %INSTALL_DIR%
) else (
    echo       Directory exists: %INSTALL_DIR%
)

echo [2/6] Copying agent files...
xcopy /E /I /Y /Q "%SCRIPT_DIR%*" "%INSTALL_DIR%\" >nul 2>&1
if %errorLevel% neq 0 (
    echo ERROR: Failed to copy files
    pause
    exit /b 1
)
echo       Files copied successfully

echo [3/6] Configuring agent...

:: Default values come from config.json (must match the server's security.agentKey)
set "DEFAULT_SERVER=http://localhost:3000"
set "DEFAULT_KEY="
for /f "usebackq delims=" %%k in (`powershell -NoProfile -Command "Get-Content '%~dp0config.json' -Raw | ConvertFrom-Json | Select-Object -ExpandProperty serverUrl"`) do set "DEFAULT_SERVER=%%k"
for /f "usebackq delims=" %%k in (`powershell -NoProfile -Command "Get-Content '%~dp0config.json' -Raw | ConvertFrom-Json | Select-Object -ExpandProperty agentKey"`) do set "DEFAULT_KEY=%%k"
if "%DEFAULT_SERVER%"=="" set "DEFAULT_SERVER=http://localhost:3000"
if "%DEFAULT_KEY%"=="" set "DEFAULT_KEY=monitoring-agent-secret-key"

:: Get server URL
set /p SERVER_URL="Enter dashboard server URL (default: %DEFAULT_SERVER%): "
if "%SERVER_URL%"=="" set SERVER_URL=%DEFAULT_SERVER%

:: Get agent key
set /p AGENT_KEY="Enter agent key (press Enter to use configured key): "
if "%AGENT_KEY%"=="" set AGENT_KEY=%DEFAULT_KEY%

:: Update config.json
powershell -NoProfile -Command ^
    "$cfg = Get-Content '%INSTALL_DIR%\config.json' | ConvertFrom-Json; ^
     $cfg.serverUrl = '%SERVER_URL%'; ^
     $cfg.agentKey = '%AGENT_KEY%'; ^
     $cfg.machineName = $env:COMPUTERNAME; ^
     $cfg | ConvertTo-Json -Depth 10 | Set-Content '%INSTALL_DIR%\config.json'"

echo       Server: %SERVER_URL%
echo       Machine: %COMPUTERNAME%

echo [4/6] Installing dependencies...
cd /d "%INSTALL_DIR%"
if exist "%INSTALL_DIR%\node_modules\sql.js" (
    echo       Bundled node_modules already present - no internet needed
) else (
    call npm install --production --silent 2>nul
    if !errorLevel! neq 0 (
        echo WARNING: Some dependencies may not have installed correctly
    )
)
echo       Dependencies installed

echo [5/6] Installing Windows service...
node install-service.js --install
if %errorLevel% neq 0 (
    echo WARNING: Service installation may have encountered issues
)

echo [6/6] Registering auto-start...

:: Create VBS launcher for invisible startup
(
echo Set WshShell = CreateObject^("WScript.Shell"^)
echo WshShell.Run "cmd /c cd /d ""%INSTALL_DIR%"" && node monitor.js", 0, False
) > "%INSTALL_DIR%\launcher.vbs"

:: Add to Windows startup via Registry (runs on user login)
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "SysMonAgent" /t REG_SZ /d "wscript.exe \"%INSTALL_DIR%\launcher.vbs\"" /f >nul 2>&1

:: Also add to startup folder as backup
copy /Y "%INSTALL_DIR%\launcher.vbs" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SysMonAgent.vbs" >nul 2>&1

echo       Auto-start configured

echo.
echo ========================================
echo  INSTALLATION COMPLETE
echo ========================================
echo.
echo  Installation Path: %INSTALL_DIR%
echo  Dashboard Server:  %SERVER_URL%
echo  Machine Name:      %COMPUTERNAME%
echo.
echo  The agent will:
echo  - Start automatically on login
echo  - Run in background (invisible)
echo  - Monitor applications, websites, files
echo  - Capture screenshots every 5 minutes
echo  - Send data to dashboard server
echo.
echo  To uninstall: Run uninstall.bat as administrator
echo  To check status: node install-service.js --status
echo ========================================
echo.
pause

