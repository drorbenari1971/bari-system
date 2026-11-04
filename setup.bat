@echo off
setlocal
chcp 65001 >nul
title Bari - Setup
cd /d "%~dp0"

echo.
echo  ==============================================
echo     Bari (bari) - one-time setup
echo  ==============================================
echo.

rem ---------- 1. Node.js (>= 22.13, needed for built-in SQLite) ----------
where node >nul 2>nul
if %errorlevel%==0 goto check_version

echo [1/5] Node.js not found. Installing Node.js LTS with winget...
where winget >nul 2>nul
if not %errorlevel%==0 goto no_winget
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
set "PATH=%PATH%;%ProgramFiles%\nodejs"
where node >nul 2>nul
if not %errorlevel%==0 goto restart_needed

:check_version
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if not %errorlevel%==0 goto old_node
for /f "delims=" %%v in ('node -v') do echo [1/5] Node.js %%v found.

rem ---------- 2. Environment file ----------
if exist "backend\.env" (
  echo [2/5] backend\.env already exists - keeping it.
) else (
  copy "backend\.env.example" "backend\.env" >nul
  echo [2/5] Created backend\.env from template - add your API keys there.
)

rem ---------- 3. Backend dependencies ----------
echo [3/5] Installing backend dependencies...
pushd backend
call npm install --no-fund --no-audit
if not %errorlevel%==0 goto npm_failed

rem ---------- 4. Database ----------
echo [4/5] Initialising SQLite database...
call npm run init-db
if not %errorlevel%==0 goto npm_failed
popd

rem ---------- 5. Frontend ----------
echo [5/5] Installing and building the frontend...
pushd frontend
call npm install --no-fund --no-audit
if not %errorlevel%==0 goto npm_failed
call npm run build
if not %errorlevel%==0 goto npm_failed
popd

echo.
echo  Setup complete!
echo   - Add API keys in:  backend\.env   (optional - demo mode works without them)
echo   - Launch with:      start.bat
echo.
pause
exit /b 0

:no_winget
echo.
echo  winget is not available. Please install Node.js LTS manually from https://nodejs.org
echo  and run setup.bat again.
pause
exit /b 1

:restart_needed
echo.
echo  Node.js was installed, but this window cannot see it yet.
echo  Close this window and run setup.bat again.
pause
exit /b 1

:old_node
for /f "delims=" %%v in ('node -v') do echo  Node.js %%v is too old. Version 22.13 or newer is required.
echo  Update with:  winget upgrade OpenJS.NodeJS.LTS   (or download from https://nodejs.org)
pause
exit /b 1

:npm_failed
popd
echo.
echo  Setup failed - see the error above.
pause
exit /b 1
