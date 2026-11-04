@echo off
setlocal
chcp 65001 >nul
title Bari - Server
cd /d "%~dp0"

if not exist "backend\node_modules" (
  echo First run detected - running setup...
  call setup.bat
)
if not exist "frontend\dist\index.html" (
  echo Building the frontend...
  pushd frontend
  call npm run build
  popd
)

rem Open the browser a few seconds after the server starts
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:4000"

echo Starting Bari on http://localhost:4000  (close this window to stop)
cd backend
node server.js
pause
