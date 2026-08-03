@echo off
title G2i for Wave - Setup & Launcher
echo ===================================================
echo           G2i for Wave Desktop App
echo ===================================================
echo.

node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed on this system!
    echo Please download and install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [1/2] Installing dependencies (this may take a minute)...
    call npm install
) else (
    echo [1/2] Dependencies already installed.
)

echo.
echo [2/2] Launching G2i for Wave...
echo.
call npm run dev
