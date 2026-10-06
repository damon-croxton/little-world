@echo off
cd /d "%~dp0"
if not exist node_modules\three\build\three.module.js (
  echo Installing local dependencies...
  call npm.cmd install --no-audit --no-fund --cache .npm-cache
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Opening LittleWorld at http://127.0.0.1:4174
node server.mjs --open
pause
