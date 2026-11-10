@echo off
REM Starts Identity against the isolated test PostgreSQL (waits for it first).
cd /d "%~dp0..\.."
set DATABASE_URL=postgres://postgres@127.0.0.1:5544/identity_test
set NODE_ENV=development
set PORT=3001
set PLATFORM_BOOTSTRAP_TOKEN=perf-bootstrap-token-0123456789abcdef
set AUTH_RATE_LIMIT=100000
set GLOBAL_RATE_LIMIT=1000000
:waitpg
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('127.0.0.1',5544)).Close(); exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 ( timeout /t 2 /nobreak >nul & goto waitpg )
node services/identity/dist/main.js > .pgtest\identity.log 2> .pgtest\identity.err.log
