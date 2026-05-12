@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

:: ============================================================
:: MetaBot Windows Installer
:: 双击运行即可完成首次安装
:: ============================================================

echo.
echo ============================================
echo   MetaBot Windows Installer
echo ============================================
echo.

:: ── 0. 管理员权限检查 ──────────────────────────────────────
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [INFO] 需要管理员权限，正在提权...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

:: ── 1. 路径设置 ────────────────────────────────────────────
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

echo [INFO] 安装目录: %ROOT%
echo.

:: ── 2. Node.js 检查 ───────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] 未检测到 Node.js，请先安装 Node.js 20+
    echo         下载: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [OK] Node.js %%v

:: ── 3. dist 检查 ───────────────────────────────────────────
if not exist "%ROOT%\dist\index.js" (
    echo [ERROR] dist\index.js 不存在，请确保已解压完整安装包
    pause
    exit /b 1
)
echo [OK] dist 目录就绪

:: ── 4. 创建目录 ────────────────────────────────────────────
if not exist "%ROOT%\conf" mkdir "%ROOT%\conf"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"

:: ── 5. 环境配置 ────────────────────────────────────────────
set "ENV_FILE=%ROOT%\conf\.env"
if not exist "%ENV_FILE%" (
    echo.
    echo ────────────────────────────────────────
    echo   步骤 1/2: 配置 API
    echo ────────────────────────────────────────
    if exist "%ROOT%\conf\.env.template" (
        copy /y "%ROOT%\conf\.env.template" "%ENV_FILE%" >nul
    ) else (
        (
            echo BOTS_CONFIG=./conf/bots.json
            echo LOG_LEVEL=info
            echo.
            echo # ── API 配置 ────────────────────────
            echo # ANTHROPIC_AUTH_TOKEN=
            echo # ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
            echo # ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.1
            echo # ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5-turbo
            echo # ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-4.5-air
            echo # CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
        ) > "%ENV_FILE%"
    )
    echo.
    echo [INFO] 已生成 conf\.env 模板，请填写 API 配置
    start /wait notepad "%ENV_FILE%"
    echo [OK] .env 已保存
)

:: ── 6. Bot 配置 ────────────────────────────────────────────
set "BOTS_FILE=%ROOT%\conf\bots.json"
if not exist "%BOTS_FILE%" (
    echo.
    echo ────────────────────────────────────────
    echo   步骤 2/2: 配置飞书机器人
    echo ────────────────────────────────────────
    if exist "%ROOT%\conf\bots.json.template" (
        copy /y "%ROOT%\conf\bots.json.template" "%BOTS_FILE%" >nul
    ) else (
        (
            echo {
            echo   "feishuBots": [
            echo     {
            echo       "name": "mybot",
            echo       "description": "My Bot - Claude Code Agent",
            echo       "feishuAppId": "cli_xxxxxxxxxxxxxxxx",
            echo       "feishuAppSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            echo       "defaultWorkingDirectory": "%ROOT:\=\\%"
            echo     }
            echo   ]
            echo }
        ) > "%BOTS_FILE%"
    )
    echo.
    echo [INFO] 已生成 conf\bots.json 模板，请填写飞书机器人凭证
    start /wait notepad "%BOTS_FILE%"
    echo [OK] bots.json 已保存
)

echo.
echo ────────────────────────────────────────
echo   安装服务
echo ────────────────────────────────────────
echo.

:: ── 7. 生成启动脚本 ───────────────────────────────────────
set "START_CMD=%ROOT%\start.cmd"
(
    echo @echo off
    echo setlocal
    echo cd /d "%ROOT%"
    echo.
    echo :: 读取 conf\.env 中的环境变量
    echo for /f "usebackq tokens=1,* delims==" %%%%a in ^("conf\.env"^) do ^(
    echo     set "LINE=%%%%a"
    echo     if not "%%%%a"=="" if not "%%%%~a"=="" ^(
    echo         set "%%%%a=%%%%b"
    echo     ^)
    echo ^)
    echo.
    echo node dist\index.js
) > "%START_CMD%"
echo [OK] start.cmd 生成完成

:: ── 8. 下载 WinSW ─────────────────────────────────────────
set "WINSW=%ROOT%\MetaBot.exe"
if not exist "%WINSW%" (
    echo [INFO] 正在下载 WinSW...
    powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe' -OutFile '%WINSW%'" 2>nul
    if not exist "%WINSW%" (
        echo [ERROR] 下载失败，请手动下载 WinSW-x64.exe 重命名为 MetaBot.exe
        echo         https://github.com/winsw/winsw/releases
        pause
        exit /b 1
    )
    echo [OK] WinSW 下载完成
) else (
    echo [OK] MetaBot.exe 已存在
)

:: ── 9. 生成 WinSW XML ─────────────────────────────────────
set "WINSW_XML=%ROOT%\MetaBot.xml"
(
    echo ^<service^>
    echo   ^<id^>MetaBot^</id^>
    echo   ^<name^>MetaBot^</name^>
    echo   ^<description^>MetaBot - Feishu to Claude Code Bridge^</description^>
    echo   ^<executable^>%ROOT%\start.cmd^</executable^>
    echo   ^<startmode^>Automatic^</startmode^>
    echo   ^<delayedAutoStart/^>
    echo   ^<log mode="roll-by-size"^>
    echo     ^<sizeThreshold^>10240^</sizeThreshold^>
    echo     ^<keepFiles^>5^</keepFiles^>
    echo     ^<logpath^>%ROOT%\logs^</logpath^>
    echo   ^</log^>
    echo   ^<onfailure action="restart" delay="10 sec"/^>
    echo   ^<onfailure action="restart" delay="30 sec"/^>
    echo   ^<onfailure action="restart" delay="60 sec"/^>
    echo   ^<resetfailure^>1 hour^</resetfailure^>
    echo ^</service^>
) > "%WINSW_XML%"
echo [OK] MetaBot.xml 生成完成

:: ── 10. 安装并启动服务 ────────────────────────────────────
echo [INFO] 正在安装 MetaBot 服务...
"%WINSW%" install 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] 服务安装失败
    pause
    exit /b 1
)
echo [OK] 服务安装成功

echo [INFO] 正在启动...
"%WINSW%" start 2>nul
echo [OK] MetaBot 服务已启动

echo.
echo ============================================
echo   安装完成!
echo.
echo   服务名称:  MetaBot
echo   管理方式:
echo     服务管理器:  services.msc
echo     命令行:
echo       启动: MetaBot.exe start
echo       停止: MetaBot.exe stop
echo       重启: MetaBot.exe restart
echo       状态: MetaBot.exe status
echo       卸载: MetaBot.exe uninstall
echo.
echo   配置文件:
echo     API:   conf\.env
echo     机器人: conf\bots.json
echo.
echo   更新部署:
echo     1. 停止服务: MetaBot.exe stop
echo     2. 覆盖 dist 目录
echo     3. 启动服务: MetaBot.exe start
echo     或直接运行 update.bat
echo ============================================
echo.
pause
