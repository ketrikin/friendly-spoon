@echo off
rem Starts the SQL Query Builder local server and opens it in your browser.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (
  echo Installing dependencies, this happens only once...
  call npm install || (pause & exit /b 1)
)
node server\server.js --open
pause
