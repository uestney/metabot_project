@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

:: ============================================================
:: MetaBot Windows Updater
:: 覆盖 dist 目录并重启服务
:: ============================================================

echo.
echo ============================================
echo   MetaBot Windows Updater
echo ============================================
echo.

net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

if not exist "%ROOT%\MetaBot.exe" (
    echo [ERROR] MetaBot.exe 不存在，请先运行 install.bat
    pause
    exit /b 1
)

if not exist "%ROOT%\dist\index.js" (
    echo [ERROR] dist\index.js 不存在，请确保新版本文件已解压到当前目录
    pause
    exit /b 1
)

:: 停止服务
echo [INFO] 停止 MetaBot 服务...
"%ROOT%\MetaBot.exe" stop 2>nul
timeout /t 2 /nobreak >nul

:: 启动服务
echo [INFO] 启动 MetaBot 服务...
"%ROOT%\MetaBot.exe" start 2>nul
if %errorlevel% equ 0 (
    echo [OK] MetaBot 已更新并重启
) else (
    echo [ERROR] 启动失败，请检查 logs\ 目录
)

echo.
pause
