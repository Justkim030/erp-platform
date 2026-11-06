$ErrorActionPreference = 'Stop'
$bin = "C:\Program Files\PostgreSQL\18\bin"
$env:PGPASSWORD = ''
$h = '127.0.0.1'; $p = '5544'; $u = 'postgres'
function Run($file, $args) { $out = & $file @args 2>&1; if ($LASTEXITCODE -ne 0) { throw "$file failed: $out" }; return $out }

# 1. backup both databases (custom format)
New-Item -ItemType Directory -Force backups | Out-Null
$stamp = 'demo-test'
Run "$bin\pg_dump.exe" @('-h', $h, '-p', $p, '-U', $u, '-Fc', '-f', "backups\identity-$stamp.dump", 'identity_test')
Run "$bin\pg_dump.exe" @('-h', $h, '-p', $p, '-U', $u, '-Fc', '-f', "backups\attendance-$stamp.dump", 'attendance_test')
Write-Output ("identity dump: {0} bytes, attendance dump: {1} bytes" -f (Get-Item "backups\identity-$stamp.dump").Length, (Get-Item "backups\attendance-$stamp.dump").Length)

# capture expected migration counts BEFORE destroying
$beforeId = (Run "$bin\psql.exe" @('-h', $h, '-p', $p, '-U', $u, '-d', 'identity_test', '-tAc', 'SELECT count(*) FROM schema_migrations')) -join ''
$beforeAt = (Run "$bin\psql.exe" @('-h', $h, '-p', $p, '-U', $u, '-d', 'attendance_test', '-tAc', 'SELECT count(*) FROM schema_migrations')) -join ''
Write-Output "before: identity_migrations=$beforeId attendance_migrations=$beforeAt"

# 2. drop both databases
Run "$bin\psql.exe" @('-h', $h, '-p', $p, '-U', $u, '-d', 'postgres', '-c', 'DROP DATABASE identity_test')
Run "$bin\psql.exe" @('-h', $h, '-p', $p, '-U', $u, '-d', 'postgres', '-c', 'DROP DATABASE attendance_test')
Write-Output "dropped both"

# 3. recreate empty and restore
Run "$bin\psql.exe" @('-h', $h, '-p', $p, '-U', $u, '-d', 'postgres', '-c', 'CREATE DATABASE identity_test')
Run "$bin\psql.exe" @('-h', $h, '-p', $p, '-U', $u, '-d', 'postgres', '-c', 'CREATE DATABASE attendance_test')
Run "$bin\pg_restore.exe" @('-h', $h, '-p', $p, '-U', $u, '-d', 'identity_test', '--no-owner', "backups\identity-$stamp.dump")
Run "$bin\pg_restore.exe" @('-h', $h, '-p', $p, '-U', $u, '-d', 'attendance_test', '--no-owner', "backups\attendance-$stamp.dump")
Write-Output "restored both"

# 4. verify
$afterId = (Run "$bin\psql.exe" @('-h', $h, '-p', $p, '-U', $u, '-d', 'identity_test', '-tAc', 'SELECT count(*) FROM schema_migrations')) -join ''
$afterAt = (Run "$bin\psql.exe" @('-h', $h, '-p', $p, '-U', $u, '-d', 'attendance_test', '-tAc', 'SELECT count(*) FROM schema_migrations')) -join ''
$tId = (Run "$bin\psql.exe" @('-h', $h, '-p', $p, '-U', $u, '-d', 'identity_test', '-tAc', "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")) -join ''
$tAt = (Run "$bin\psql.exe" @('-h', $h, '-p', $p, '-U', $u, '-d', 'attendance_test', '-tAc', "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")) -join ''
Write-Output "after: identity_migrations=$afterId attendance_migrations=$afterAt identity_tables=$tId attendance_tables=$tAt"
if ($afterId -ne $beforeId) { throw 'identity migration count mismatch after restore' }
if ($afterAt -ne $beforeAt) { throw 'attendance migration count mismatch after restore' }
if ([int]$tId -lt 7) { throw 'identity tables missing after restore' }
if ([int]$tAt -lt 4) { throw 'attendance tables missing after restore' }
Write-Output 'RESTORE VERIFIED'
