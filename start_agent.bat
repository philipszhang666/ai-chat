@echo off
REM ============================================================
REM  Agent Launcher for Windows
REM ============================================================
REM  Copy this file to ANY folder you want as the sandbox root,
REM  then double-click to start the Agent backend.
REM  The sandbox root is auto-locked to this .bat file's folder.
REM  Optional: set AGENT_HOME to point to your agent repo if this
REM  launcher is copied outside the repo.
REM ============================================================

REM Switch console to UTF-8 so Python emoji output renders correctly
chcp 65001 >nul 2>&1

REM Agent code home. Defaults to this script's folder.
if not defined AGENT_HOME set "AGENT_HOME=%~dp0"
if "%AGENT_HOME:~-1%"=="\" set "AGENT_HOME=%AGENT_HOME:~0,-1%"

REM Sandbox root = folder containing this .bat
set "WORKSPACE=%~dp0"

REM Strip trailing backslash (argparse can be picky)
if "%WORKSPACE:~-1%"=="\" set "WORKSPACE=%WORKSPACE:~0,-1%"

echo.
echo ============================================================
echo   Agent Launcher
echo ============================================================
echo   Code home : %AGENT_HOME%
echo   Sandbox   : %WORKSPACE%
echo ============================================================
echo.

if not exist "%AGENT_HOME%\local_terminal_server.py" (
    echo [ERROR] Cannot find %AGENT_HOME%\local_terminal_server.py
    echo         Set AGENT_HOME to the agent repo path, then run this script again.
    echo         Example: set AGENT_HOME=D:\path\to\agent
    pause
    exit /b 1
)

python "%AGENT_HOME%\local_terminal_server.py" --workspace "%WORKSPACE%" %*

REM Keep window open after server exits so user can read errors
pause
