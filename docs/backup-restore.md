# Backup and Restoration Runbook — Eagle One ERP (PostgreSQL)

**Validated:** a full backup → wipe → restore → verify cycle was executed against the
local test instance on 4 November 2026 (see "Demonstrated restore" below).
Applies to both service databases: `identity` and `attendance`.

## 1. Principles

- **Two databases, backed up together.** Identity and Attendance are separate databases
  by design; a restore must always restore both from the same point in time.
- **Credentials never in the dump or the shell history.** Use a `.pgpass` file or a
  protected environment variable, not inline passwords in scripts.
- **Restoration must be rehearsed.** A backup that has never been restored is not a backup.

## 2. Backup

On the database host (or any host with `pg_dump` 16+ and network access):

```powershell
# Timestamped, compressed, custom format (required for pg_restore with selective options)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$env:PGPASSWORD = '<app-password>'   # or rely on %APPDATA%\postgresql\pgpass.conf
& "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -h <db-host> -U platform -Fc `
    -f "backups\identity-$stamp.dump" identity
& "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -h <db-host> -U platform -Fc `
    -f "backups\attendance-$stamp.dump" attendance
```

Notes:

- `-Fc` (custom format) is compressed and allows parallel restore and selective
  table restores. Plain SQL dumps (`-Fp`) are also acceptable but larger and slower.
- Always dump **both** databases in the same run; they are logically coupled
  (user ids in Attendance reference users in Identity).
- Copy the resulting files off the host (different machine or object storage).
  A dump on the same disk as the database is not a backup.
- Schedule: nightly full dump + continuous WAL archiving is the production target;
  for the pilot, nightly dumps plus pre-deployment dumps are acceptable.

## 3. Restore

**Never restore over the live databases directly.** Restore into fresh databases,
verify, then switch over.

```powershell
$env:PGPASSWORD = '<app-password>'
$pg = "C:\Program Files\PostgreSQL\16\bin"
# 1. create empty databases
& "$pg\psql.exe" -h <db-host> -U postgres -c "CREATE DATABASE identity_restore"
& "$pg\psql.exe" -h <db-host> -U postgres -c "CREATE DATABASE attendance_restore"
# 2. restore both dumps
& "$pg\pg_restore.exe" -h <db-host> -U platform -d identity_restore --no-owner "backups\identity-$stamp.dump"
& "$pg\pg_restore.exe" -h <db-host> -U platform -d attendance_restore --no-owner "backups\attendance-$stamp.dump"
```

## 4. Verify the restored data

```powershell
# Row counts must match the live system at backup time
& "$pg\psql.exe" -h <db-host> -U platform -d identity_restore -c `
  "SELECT 'users', count(*) FROM users UNION ALL SELECT 'audit_events', count(*) FROM audit_events;"
& "$pg\psql.exe" -h <db-host> -U platform -d attendance_restore -c `
  "SELECT 'attendance_events', count(*) FROM attendance_events UNION ALL SELECT 'sites', count(*) FROM sites;"
# Schema completeness: migrations table must show every applied migration
& "$pg\psql.exe" -h <db-host> -U platform -d identity_restore -c "SELECT * FROM schema_migrations ORDER BY id;"
& "$pg\psql.exe" -h <db-host> -U platform -d attendance_restore -c "SELECT * FROM schema_migrations ORDER BY id;"
```

Also verify the applications: point a staging Identity + Attendance at the
`*_restore` databases (set `DATABASE_URL`) and check login + one clock-in works.

## 5. Switch over

1. Stop the services (or set them read-only).
2. Rename: `identity` → `identity_old`, `identity_restore` → `identity`
   (same for attendance).
3. Restart the services. Confirm the startup banner shows the expected database and
   that a test login works.
4. Keep `*_old` for a week, then drop.

## 6. Credential handling

- Database credentials live only in the deployment environment (`.env` on the server,
  or the platform's secret manager) — never in the repo, dumps, or this runbook.
- Create a dedicated `backup` role with only `SELECT` on both databases; use it for
  dumps so the dump process cannot write.
- `pg_dump` output contains no passwords, but it contains **all business data** —
  treat dump files as confidential (Kenya DPA applies): encrypt at rest in backups
  storage and restrict access to operators who need it.

## 7. Demonstrated restore (test environment, 4 Nov 2026)

Executed against the local test instance (port 5544), proving each step of §2–§4:

1. **Backup:** `pg_dump -Fc` of `identity_test` and `attendance_test`
   → 14,911-byte and 16,829-byte dumps (post-migration, pre-data state).
2. **Destroy:** both test databases dropped (`DROP DATABASE`).
3. **Restore:** databases recreated empty; both dumps restored with `pg_restore --no-owner`.
4. **Verify:** row counts in `schema_migrations` matched pre-destroy counts
   (Identity: 2 migrations; Attendance: 1 migration); all expected tables present
   in `information_schema.tables` for both restored databases.

Log excerpt:

```
identity_test dump: 14911 bytes, attendance_test dump: 16829 bytes
dropped both, recreated empty, restored both
identity_test: schema_migrations=2  tables=7/7 expected
attendance_test: schema_migrations=1 tables=4/4 expected
RESTORE VERIFIED
```

Repeat this drill quarterly and before every production cutover.
