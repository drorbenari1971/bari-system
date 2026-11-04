@echo off
rem Development mode: backend with auto-restart (:4000) + Vite hot-reload UI (:5173)
chcp 65001 >nul
cd /d "%~dp0"
start "Bari API (dev)" cmd /k "cd /d "%~dp0backend" && npm run dev"
start "Bari UI (dev)" cmd /k "cd /d "%~dp0frontend" && npm run dev"
timeout /t 4 /nobreak >nul
start http://localhost:5173
