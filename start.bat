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

rem Webhook tunnel (optional): if ngrok is installed, start the endpoint named "bari-webhooks" from
rem ngrok's own local config (its address is kept there, not in the project), unless already running.
rem Without ngrok the app runs as usual and Morning data still arrives through the periodic sync.
where ngrok >nul 2>nul && (
  tasklist /fi "imagename eq ngrok.exe" | find /i "ngrok.exe" >nul || (
    echo Starting the webhook tunnel...
    start "Bari - Webhook tunnel" /min ngrok start bari-webhooks
  )
)

rem Open the browser a few seconds after the server starts
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:4000"

echo Starting Bari on http://localhost:4000  (close this window to stop)
cd backend
node server.js
pause
