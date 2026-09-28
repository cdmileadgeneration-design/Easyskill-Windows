@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==========================================
echo  Windows Monitoring - Project Setup
echo ==========================================
echo.

:: ---- [1/5] Node.js ---------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 goto :noNode
where npm >nul 2>&1
if errorlevel 1 goto :noNpm
for /f "delims=" %%v in ('node -v') do set "NODE_VER=%%v"
for /f "delims=" %%v in ('npm -v') do set "NPM_VER=%%v"
echo [1/5] Node.js !NODE_VER! / npm !NPM_VER! found

:: ---- [2/5] .env ------------------------------------------------------------
if exist ".env" (
    echo [2/5] .env already exists - keeping your values
) else (
    if exist ".env.example" (
        copy /Y ".env.example" ".env" >nul
        echo [2/5] .env created from .env.example - fill in MongoDB / Cloudinary values
    ) else (
        echo [2/5] WARNING: neither .env nor .env.example found
    )
)

:: ---- [3/5] config.json -----------------------------------------------------
if exist "config.json" (
    echo [3/5] config.json already exists - keeping your values
) else if exist "config.example.json" (
    copy /Y "config.example.json" "config.json" >nul
    node -e "const fs=require('fs'),c=require('crypto');const p='config.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.security.jwtSecret=c.randomBytes(48).toString('hex');fs.writeFileSync(p,JSON.stringify(j,null,2));"
    echo [3/5] config.json created with a random security.jwtSecret
) else (
    echo [3/5] WARNING: config.example.json not found
)

:: ---- [4/5] dashboard dependencies ------------------------------------------
echo [4/5] Installing dashboard dependencies...
pushd "%~dp0dashboard"
call npm install --no-audit --no-fund
set "DASH_ERR=!errorlevel!"
popd
if not "!DASH_ERR!"=="0" goto :fail

:: ---- [5/5] agent dependencies ----------------------------------------------
echo [5/5] Installing agent dependencies...
pushd "%~dp0agent"
call npm install --no-audit --no-fund
set "AG_ERR=!errorlevel!"
popd
if not "!AG_ERR!"=="0" goto :fail

echo.
echo ==========================================
echo  SETUP COMPLETE
echo ==========================================
echo.
echo  Next steps:
echo    1. Edit .env  - MONGODB_URI, CLOUDINARY_* keys, STORAGE_PROVIDER
echo    2. Start dashboard:   cd dashboard ^&^& npm start
echo    3. Open http://localhost:3000   (admin / admin - change it!)
echo    4. Deploy agent on target PCs:  agent\install.bat (Run as administrator)
echo.
echo  Later AWS migration: set STORAGE_PROVIDER=s3 plus S3_BUCKET / AWS_* in .env
echo  and keep DB_PROVIDER=mongodb (Atlas) or point it at your own instance.
echo ==========================================
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
