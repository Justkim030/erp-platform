# Creates and starts a dedicated throwaway PostgreSQL test instance on port 5544.
# Isolated from any other PostgreSQL on this machine. Data lives in .pgtest/ and is disposable.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-db-init.ps1 [-Stop]
param([switch]$Stop)

$bin = "C:\Program Files\PostgreSQL\18\bin"
$root = Join-Path $PSScriptRoot "..\.pgtest"
$data = Join-Path $root "data"

if ($Stop) {
  & "$bin\pg_ctl.exe" -D $data stop -m fast 2>$null
  exit 0
}

if (-not (Test-Path (Join-Path $data "PG_VERSION"))) {
  New-Item -ItemType Directory -Force $root | Out-Null
  & "$bin\initdb.exe" -D $data -U postgres --auth=trust --encoding=UTF8 -E UTF8 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "initdb failed" }
  # listen only on localhost, port 5544
  Add-Content (Join-Path $data "postgresql.conf") "listen_addresses = '127.0.0.1'"
  Add-Content (Join-Path $data "postgresql.conf") "port = 5544"
}

$running = & "$bin\pg_ctl.exe" -D $data status 2>$null | Out-String
if ($running -notmatch "server is running") {
  & "$bin\pg_ctl.exe" -D $data -l (Join-Path $root "testdb.log") start | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "pg_ctl start failed" }
}

# create the two service databases if missing
foreach ($db in @("identity_test", "attendance_test")) {
  $exists = & "$bin\psql.exe" -U postgres -h 127.0.0.1 -p 5544 -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'"
  if ($exists -ne '1') {
    & "$bin\psql.exe" -U postgres -h 127.0.0.1 -p 5544 -d postgres -c "CREATE DATABASE $db" | Out-Null
  }
}
Write-Output "TEST DB READY: host=127.0.0.1 port=5544 user=postgres databases=identity_test,attendance_test"
