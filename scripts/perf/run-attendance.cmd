@echo off
REM Starts Attendance against the isolated test PostgreSQL (waits for DB and Identity).
cd /d "%~dp0..\.."
set DATABASE_URL=postgres://postgres@127.0.0.1:5544/attendance_test
set NODE_ENV=development
set PORT=3002
set IDENTITY_JWKS_URL=http://127.0.0.1:3001/.well-known/jwks.json
set IDENTITY_URL=http://127.0.0.1:3001
set CLOCK_RATE_LIMIT=100000
set GLOBAL_RATE_LIMIT=1000000
set ROSTER_TTL_MS=5000
set DB_POOL_MAX=20
set TIMEZONE=Africa/Nairobi
:wait
powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient('127.0.0.1',5544)).Close(); (Invoke-WebRequest -Uri http://127.0.0.1:3001/healthz -UseBasicParsing -TimeoutSec 2) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 ( timeout /t 2 /nobreak >nul & goto wait )
node services/attendance/dist/main.js > .pgtest\attendance.log 2> .pgtest\attendance.err.log
