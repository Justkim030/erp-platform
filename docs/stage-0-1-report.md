# Stage 0 + Stage 1 completion report

**Date:** 4 November 2026 · **Scope:** verification debt + architecture corrections only
(no Stage 2+ features were implemented).

## 1. Baseline (verified before any change)

What worked: 39 pg-mem tests green; typecheck and build clean; services ran in dev mode;
both databases migrate cleanly on pg-mem; verification logic correct.

What was unsafe (all confirmed in source, then fixed below):

| Issue                                                                                  | Location                        | Severity    |
| -------------------------------------------------------------------------------------- | ------------------------------- | ----------- |
| Clock-in/out check-then-insert not atomic → two concurrent requests can both succeed   | `attendance.service.ts clock()` | Critical    |
| Audit writes best-effort, outside business transactions                                | both `AuditService`s            | High        |
| No pagination on `GET /v1/users`, `GET /v1/attendance/history`, `GET /v1/team/reviews` | both services                   | Medium      |
| In-memory mode reachable in production (dev scripts default; no config validation)     | `main.ts`/config both services  | High        |
| pg-mem cannot test migrations, advisory locks, true concurrency                        | test suites                     | Structural  |
| No backup/restore procedure                                                            | —                               | Operational |

Discrepancies vs the previous audit: none material. Two details refined — the audit's
"no unique backstop" claim was confirmed, but a partial unique index **cannot** express
the open-session invariant (index predicates can't reference other rows); that backstop
correctly arrives with Stage 3's `attendance_sessions` table, and the limitation is
documented in `migrations.ts` and §4 below.

## 2. Files modified or created

**Modified (11):**

- `services/attendance/src/attendance.service.ts` — transactional `clock()` and `review()`; pagination in `history()`/`reviews()`
- `services/attendance/src/support.ts` — `AuditService.recordWithinTx`; correlation ids in audit
- `services/attendance/src/migrations.ts` — invariant note (no schema change needed in this stage)
- `services/attendance/src/config.ts` — `validateProductionConfig`
- `services/attendance/src/main.ts` — fail-fast startup, JSON logger, db banner
- `services/attendance/src/setup.ts`, `src/controllers.ts` — correlation middleware; ids through to services
- `services/identity/src/config.ts`, `src/main.ts`, `src/setup.ts`, `src/controllers.ts` — same treatment for Identity
- `services/identity/src/admin.service.ts` — transactional audit for user create/reset/platform paths; pagination in `listUsers`
- `services/identity/src/audit.ts` — `recordWithinTx`
- `services/identity/src/auth.service.ts` — correlation id on login audits; `Ctx` type extended
- `package.json` (root), both service `package.json`s — `test:pg`, `start:*` scripts
- `apps/portal-web/app/api/svc/[service]/[...path]/route.ts` — correlation-id propagation
- `README.md`, `docs/eagle-one-audit.md` — status updates

**Created (10):**

- `services/attendance/src/log.ts`, `src/correlation.ts` (+ identity copies)
- `services/attendance/test/attendance-real-db.spec.ts` (9 tests)
- `services/identity/test/identity-real-db.spec.ts` (7 tests)
- `services/attendance/test/setup.ts` — pg-mem shims for advisory locks (unit tests only)
- `scripts/test-db-init.ps1`, `scripts/restore-drill.ps1`
- `docs/backup-restore.md`, `docs/role-model.md`, `docs/physical-verification.md`, `docs/logging-and-tracing.md`, `docs/stage-0-1-report.md` (this file)

## 3. Migrations

**None required.** The Stage 1 fixes are behavioural (transactions, locks, audit placement).
A schema-level unique backstop for the open-session invariant is deliberately deferred to
Stage 3's `attendance_sessions` table — see the note in `attendance/src/migrations.ts`.
All existing migrations remain; the migration runner was itself verified against real
PostgreSQL (idempotent rerun tested in both services).

## 4. Concurrency solution (clock-in/out)

```
BEGIN
  SELECT pg_advisory_xact_lock(hashtextextended('<tenant>:<user>', 0))
  SELECT last effective event for user            -- state check
  → conflict? raise 409 (transaction rolls back; nothing written)
  INSERT attendance_event
  INSERT audit_event (same transaction)
COMMIT / ROLLBACK
```

- **Transaction-scoped advisory lock** serialises all state transitions per worker;
  concurrent requests for the same worker queue behind the lock, then see the updated
  state — the second request gets a clean 409.
- The event and its audit row commit or roll back **together** — no orphan audit rows,
  no un-audited events, no partial state on failure.
- Request-scoped locks (`pg_advisory_xact_lock`) auto-release at commit/rollback, so
  failures cannot leak locks.
- Why not a unique constraint today: the "one open session" invariant spans rows
  (a clock-out must "close" the preceding clock-in), which a partial index on a single
  row cannot express. Stage 3's materialised sessions table will carry
  `UNIQUE (tenant_id, user_id) WHERE status='open'` as the definitive backstop.
- **Verified with real concurrent HTTP clients** against real PostgreSQL: 8 simultaneous
  clock-ins → exactly one 201, seven 409s, one event row; same for clock-outs; mixed
  in/out races → exactly one winner; state stays consistent.

## 5. Transactional audit

`AuditService.recordWithinTx(q, e)` writes inside the caller's transaction and is now
used by every critical action:

- Attendance: clock-in, clock-out, review decisions — audit row in the same tx as the event/decision.
- Identity: user creation, access reset, organisation creation, platform user creation — audit row in the same tx as the business write.

Login audits (success/failure/lockout) intentionally remain best-effort `record()`:
authentication routes are rate-limited and attack surfaces; making them transactional
with the login read would let an attacker hold row locks. The boundary is documented in
`audit.ts` and `docs/logging-and-tracing.md`.

Audit rows now carry: tenant, actor, action, target, IP, UA, timestamp, correlation id
(in metadata), and richer metadata (e.g. `previousDecision` on reviews, `previousStatus`
on access resets). No secrets or tokens are ever written to audit metadata.

## 6. Logging and correlation IDs

JSON-per-line logs in both services (`log.ts`); `CorrelationIdMiddleware` on both;
BFF propagates/mints `x-correlation-id` end-to-end and echoes it to the browser;
critical audits store the id in metadata. Tracing instructions: `docs/logging-and-tracing.md`.

## 7. Role-mapping documentation

`docs/role-model.md` — the four roles, exact endpoint permissions per role, route-level
vs object-level enforcement, why `admin` and `management` are distinct, platform
endpoints' separate token model, extensibility path for fine-grained management roles,
and the documented 10-minute token limitation.

## 8. Physical supervisor verification (mandatory future requirement)

`docs/physical-verification.md` — evidence taxonomy (GPS/network/geofence vs human
attestation), lifecycle integration point (attaches to Stage 3 sessions), full record
contract (`physical_verifications` table), authorisation rules (supervisor → own team,
never self), missing/rejected/disputed semantics, and **five open policy questions for
Eagle One**. Explicitly not implemented in this stage; no code marks anything
"physically verified" from GPS.

## 9. Backup and restore

`docs/backup-restore.md` — dump/restore/verify/switchover procedures, credential
handling, and the **demonstrated drill**: both test databases dumped (`-Fc`), dropped,
recreated empty, restored, and verified (schema_migrations and table counts matched
exactly). The drill script is committed (`scripts/restore-drill.ps1`) so it can be
re-run quarterly.

## 10. Commands (Windows 11, PowerShell)

```powershell
# one-time setup
npm install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-db-init.ps1   # isolated PG on :5544

# fast tests (pg-mem, no database needed)
npm test

# real-PostgreSQL tests (migrations, transactions, concurrency)
$env:TEST_DATABASE_URL = 'postgres://postgres@127.0.0.1:5544/identity_test';   npm run test:pg
$env:TEST_DATABASE_URL = 'postgres://postgres@127.0.0.1:5544/attendance_test'; npm run test:pg

# typecheck + build
npm run typecheck
npm run build

# development (in-memory, resets on restart — never for real data)
npm run dev:identity       # terminal 1
npm run dev:attendance     # terminal 2
$env:IDENTITY_URL='http://localhost:3001'; $env:ATTENDANCE_URL='http://localhost:3002'; $env:DEFAULT_ORG='demo'; npm run dev:portal   # terminal 3

# production start (real database required; fail-fast on missing config)
npm run build; npm run start:identity; npm run start:attendance; npm run start:portal

# backup drill (safe: runs against the test instance)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restore-drill.ps1
```

## 11. Test results (exact counts, all executed)

| Suite                    | Environment                                      | Result                                                                                                                                 |
| ------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Identity unit (19)       | pg-mem                                           | **19/19 pass**                                                                                                                         |
| Attendance unit (20)     | pg-mem (with documented shim for advisory locks) | **20/20 pass**                                                                                                                         |
| Identity real-DB (7)     | real PostgreSQL 18.4                             | **7/7 pass**                                                                                                                           |
| Attendance real-DB (9)   | real PostgreSQL 18.4                             | **9/9 pass**                                                                                                                           |
| Typecheck (3 workspaces) | —                                                | **clean**                                                                                                                              |
| Build (3 workspaces)     | —                                                | **clean**                                                                                                                              |
| Docker image builds      | —                                                | **NOT run — Docker is not installed on this machine** (build/runtime stages were verified by local simulation in the previous session) |

Real-DB suites skip cleanly (reported as skipped, never as passed) when
`TEST_DATABASE_URL` is unset.

## 12. Remaining limitations

1. In-memory rate-limit counters — single-instance only (documented; Redis deferred).
2. Roster fetch from Attendance to Identity per team view (30 s cache) — fine at current scale; events/outbox later.
3. Dockerfiles verified by local simulation only, not by `docker build` (no Docker here).
4. The database-level backstop for the open-session invariant waits for Stage 3 sessions.
5. pg-mem unit tests use a shim for advisory-lock functions; real semantics are covered only by the real-DB suite (by design).

## 13. Security risks still present

1. **CSP still report-only** — must flip to `enforce` after real-device browser testing.
2. **OpenStreetMap public tiles** — fine for pilot; production needs a proper tile provider (usage policy + availability).
3. **No HTTPS termination config in the repo** — deployment must put TLS in front (COOKIE_SECURE=true then).
4. **Attachments don't exist yet** — when they do (Stage 4+), upload validation and access control must be designed in from the start.
5. **Kenya DPA artifacts** (privacy notice, data-subject export/deletion) — documented as pending; not yet produced.

## Stage boundary

This completes Stage 0 + Stage 1. Stopping here for your review before Stage 2
(organisation structure: departments, assignment history, employee status history)
as instructed.
