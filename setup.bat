@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==========================================
echo  Easyskill-Windows - Setup
echo  (full guide: SETUP.md)
echo ==========================================
echo.

:: ---- [1/6] Node.js ---------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 goto :noNode
where npm >nul 2>&1
if errorlevel 1 goto :noNpm
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
for /f "delims=" %%v in ('npm -v') do set "NPM_VER=%%v"
echo [1/6] Node.js !NODE_VER! / npm !NPM_VER! found

:: ---- [2/6] .env -------------------------------------------------------------
if exist ".env" (
    echo [2/6] .env already exists - keeping your values
) else (
    if exist ".env.example" (
        copy /Y ".env.example" ".env" >nul
        echo [2/6] .env created from .env.example - fill in MongoDB / Cloudinary values
    ) else (
        echo [2/6] WARNING: neither .env nor .env.example found
    )
)

:: ---- [3/6] config.json ------------------------------------------------------
if exist "config.json" (
    echo [3/6] config.json already exists - keeping your values
) else if exist "config.example.json" (
    copy /Y "config.example.json" "config.json" >nul
    node -e "const fs=require('fs'),c=require('crypto');const p='config.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.security.jwtSecret=c.randomBytes(48).toString('hex');fs.writeFileSync(p,JSON.stringify(j,null,2));"
    echo [3/6] config.json created with a random security.jwtSecret
) else (
    echo [3/6] WARNING: config.example.json not found
)

:: ---- [4/6] dashboard dependencies -------------------------------------------
echo [4/6] Installing dashboard dependencies...
pushd "%~dp0dashboard"
call npm install --no-audit --no-fund
set "DASH_ERR=!errorlevel!"
popd
if not "!DASH_ERR!"=="0" goto :fail

:: ---- [5/6] agent dependencies ------------------------------------------------
echo [5/6] Installing agent dependencies...
pushd "%~dp0agent"
call npm install --no-audit --no-fund
set "AG_ERR=!errorlevel!"
popd
if not "!AG_ERR!"=="0" goto :fail

:: ---- [6/6] validate configuration --------------------------------------------
echo [6/6] Checking configuration...
node "%~dp0dashboard\check-config.js"
echo.

echo ==========================================
echo  SETUP COMPLETE
echo ==========================================
echo.
echo  Next steps:
echo    1. Edit .env  - MONGODB_URI, CLOUDINARY_* , AGENT_KEY
echo    2. Run dashboard:   cd dashboard ^&^& npm start
echo    3. Open http://localhost:3000   (admin / admin - change it!)
echo    4. Target PC pe:    agent\install.bat  (Run as administrator)
echo    5. Live on Render:  dekho deploy.txt  aur SETUP.md section 5
echo.

set "ANSWER="
set /p "ANSWER=Start the dashboard now? (Y/N) [N]: "
if /i "!ANSWER!"=="Y" (
    echo       Starting dashboard... close that window to stop it.
    start "Dashboard" /D "%~dp0dashboard" cmd /k node server.js
)

set "ANSWER="
set /p "ANSWER=Install the agent service on THIS PC? (Y/N) [N]: "
if /i "!ANSWER!"=="Y" (
    call "%~dp0agent\install.bat"
)

echo.
echo Done. Full instructions: SETUP.md  ^|  Render: deploy.txt
pause
exit /b 0

:fail
echo.
echo SETUP FAILED - check the npm output above.
pause
exit /b 1

:noNode
echo ERROR: Node.js not found.
echo Install it from https://nodejs.org LTS and run setup.bat again.
pause
exit /b 1

:noNpm
echo ERROR: npm not found with Node.js.
echo Reinstall Node.js from https://nodejs.org LTS and run setup.bat again.
pause
exit /b 1
