# Eagle One ERP — Workforce Management Module: Audit and Implementation Roadmap

**Date:** 4 November 2026
**Scope audited:** `erp-platform-v0.2` — Identity service, Attendance service, Portal (Next.js), docs, Docker setup.
**Method:** Full source inspection (both services, portal, migrations, tests, docs, Docker/compose), plus the verification run performed on 3–4 November 2026 (39 automated tests, typecheck, build, standalone-image runtime check, headless-browser walkthrough of login, dashboard, map and sites pages).

---

## Part 1 — What the current system actually is

The existing codebase is a **multi-tenant attendance platform**, not yet a workforce-management ERP. It consists of:

| Component          | Technology                                     | State                                 |
| ------------------ | ---------------------------------------------- | ------------------------------------- |
| Identity service   | NestJS + PostgreSQL (or pg-mem in dev)         | Working; 19 tests                     |
| Attendance service | NestJS + PostgreSQL (or pg-mem in dev)         | Working; 20 tests                     |
| Portal             | Next.js 14 App Router, BFF pattern             | Working; verified in headless browser |
| Deployment         | Docker Compose, 3 Dockerfiles, per-service DBs | Written, never executed               |

Key architectural facts confirmed by reading the source:

- **Two microservices, each with its own database.** Identity owns tenants, users, credentials, invites, sessions, audit. Attendance owns sites, attendance events, audit. No cross-database reads.
- **Service-to-service trust is cryptographic**: Attendance verifies Identity's Ed25519 access tokens via JWKS. The tenant id and role come from the token, never from request bodies.
- **The browser never holds tokens.** Portal is a backend-for-frontend: httpOnly cookies (`ph_at`, `ph_rt`), a strict allow-list proxy (`/api/svc/[service]/[...path]`), Origin checks on all state-changing requests, nonce-based CSP (report-only).
- **Roles are exactly four**: `worker`, `supervisor`, `management`, `admin`. Enforced in `RolesGuard` (route level) and in service code (object level — supervisors see only their own `supervisor_id` team).
- **Attendance events are append-only.** Reviews update `review_decision` columns on the same row; there is no session table, no correction-request entity, no work-report entity.
- **Coordinates are retained** (`lat`, `lng`, `accuracy_m`, `distance_m`) and purged after `RETENTION_DAYS` (90), with audited map access.

---

## Part 2 — Gap analysis against the Eagle One brief

Classifications: **✅ Implemented correctly · 🟡 Partially implemented · ❌ Missing · 🔴 Implemented incorrectly · ⚖️ Requires business decision**

### 2.1 Identity, authentication and permissions

| #   | Requirement                                           | Status | Notes                                                                                                                                                                                                              |
| --- | ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Secure sign-in for all roles                          | ✅     | Argon2id (19 MiB, OWASP params), PIN policy for workers only, dummy-hash timing equalisation, lockout after 5 failures/15 min, per-IP rate limits                                                                  |
| 2   | Session management                                    | ✅     | 10-min Ed25519 access tokens, rotating refresh tokens with family revocation on reuse                                                                                                                              |
| 3   | Three primary roles                                   | 🟡     | The system has **four** roles: `worker`, `supervisor`, `management`, `admin`. Brief asks for three. `admin` is the platform/tenant administrator; the mapping is reasonable but must be made explicit to Eagle One |
| 4   | Role-based access control                             | ✅     | `JwtGuard` + `RolesGuard` + per-query scoping by `supervisor_id` / tenant                                                                                                                                          |
| 5   | Object-level permission checks                        | 🟡     | Correct for the supervisor→team relationship. But there is **no department concept at all** — so department-level checks do not exist yet                                                                          |
| 6   | Management = org-wide                                 | ✅     | `management` and `admin` see the whole tenant; supervisors cannot escalate                                                                                                                                         |
| 7   | Future management sub-roles                           | ❌     | Permission model is a single hardcoded role string in the JWT. No permission bitmask/claim structure that would allow finer-grained management roles later                                                         |
| 8   | Employee cannot view other employees' private records | ✅     | Worker endpoints take no `userId` parameter; they always operate on the token subject                                                                                                                              |
| 9   | Account provisioning workflow                         | ✅     | Supervisor creates worker → one-time activation code (hashed, 7-day, 5-attempt limit) → worker sets PIN/password. Platform endpoints hidden behind 404-on-failure guard                                            |
| 10  | Forgotten PIN reset                                   | ✅     | Supervisor issues new code; old sessions revoked                                                                                                                                                                   |

### 2.2 Organisation structure

| #   | Requirement                        | Status | Notes                                                                                                                                                                                                             |
| --- | ---------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11  | Company/tenant entity              | ✅     | `tenants` table                                                                                                                                                                                                   |
| 12  | **Departments**                    | ❌     | No `departments` table, no `department_id` on users. This is the single largest data-model gap                                                                                                                    |
| 13  | Employee records                   | 🟡     | `users` table holds staff number, name, email, phone, role, supervisor. No employment metadata (job title, department, hire date, employment status history)                                                      |
| 14  | Supervisor assignments             | 🟡     | Simple `users.supervisor_id` column. Works, but changing a supervisor silently reassigns history interpretation; no assignment history table                                                                      |
| 15  | Department/employee change history | ❌     | No historical records for organisational changes                                                                                                                                                                  |
| 16  | Multiple workplaces                | 🟡     | `sites` table supports multiple sites per tenant — this exceeds the brief's "one main workplace" and is fine, but the brief's "workplace" concept needs care: sites are geofences, not organisational departments |

### 2.3 Attendance

| # | Requirement | Status | Notes |
|---|---|---|---`| 17 | Check-in with location evidence | ✅ | Client reading + server-side`evaluate()` verdict, reasons recorded |
| 18 | Check-out tied to work report | 🟡 | Currently the work summary is a **single text field on the clock-out event** (`work_summary`on`attendance_events`). The brief requires a structured **work report entity** with multiple activities, statuses, quantities, challenges, drafts, revisions, reviews. That is a genuine data-model addition, not a tweak |
| 19 | Checkout not blocked by pending review | ✅ | Only submission required |
| 20 | One active session per employee | ✅ | Enforced by checking `lastEffective`before insert |
| 21 | Duplicate check-in / checkout-before-checkin prevention | ✅ | Conflict checks before insert |
| 22 | Server-generated timestamps | ✅ |`new Date()`server-side; client reading timestamps only used for staleness checks |
| 23 | **Idempotency protection** | 🟡 | Duplicate submission returns 409 via the state check, but the check-then-insert is **not wrapped in a transaction** — two concurrent requests can both pass the check and both insert (race condition). The`Db`class has a`tx()`helper;`clock()` does not use it |
| 24 | Immutable event history | ✅ | Append-only inserts; corrections via review decisions |
| 25 | **Attendance corrections workflow** | ❌ | There is a review flow for flagged entries, but no employee-initiated correction/exception request (missed clock-out, forgot to clock out, worked off-site, etc.) |
| 26 | Rejected attempts preserved | ✅ | Declined events are stored with reasons |
| 27 | No physical deletion | ✅ | Retention purges coordinates only, never rows |

### 2.4 GPS and workplace verification

| #   | Requirement                                  | Status | Notes                                                                                                                                                                                                                                          |
| --- | -------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 28  | Geofence evaluation                          | ✅     | Haversine + accuracy-aware radius check, server-side                                                                                                                                                                                           |
| 29  | Configurable site parameters                 | ✅     | radius, accuracy limit, shift start, grace, timezone, allowed IPs, require-network — all per-site data                                                                                                                                         |
| 30  | Spoof plausibility checks                    | ✅     | Stale reading, impossible travel, identical coordinates, unrealistic accuracy (<1 m)                                                                                                                                                           |
| 31  | Failed attempts preserved                    | ✅     | Declined events stored                                                                                                                                                                                                                         |
| 32  | Supervisor verification as separate evidence | 🟡     | Review flow exists (`review` endpoint updates decision/note/reviewer), but there is no **on-site supervisor presence verification** action (the supervisor confirming "I can see this person here" as distinct from approving a flagged event) |
| 33  | No continuous tracking                       | ✅     | Location only at clock-in/out                                                                                                                                                                                                                  |
| 34  | Worker never told which check fired          | ✅     | `workerMessage()` gives plain guidance                                                                                                                                                                                                         |
| 35  | Future QR / device-integrity hooks           | 🟡     | `evaluate()` is a pure function — extension point exists but no interface yet for additional evidence types                                                                                                                                    |

### 2.5 Work management and reporting

| #   | Requirement                                 | Status | Notes                                                  |
| --- | ------------------------------------------- | ------ | ------------------------------------------------------ |
| 36  | Structured work report entity               | ❌     | Only a free-text `work_summary` on the clock-out event |
| 37  | Multiple activities per day                 | ❌     | —                                                      |
| 38  | Task linkage                                | ❌     | No tasks                                               |
| 39  | Status, quantity, unit                      | ❌     | —                                                      |
| 40  | Challenges, notes, attachments              | ❌     | —                                                      |
| 41  | Drafts                                      | ❌     | —                                                      |
| 42  | Revision history                            | ❌     | —                                                      |
| 43  | Supervisor acknowledgement vs clarification | ❌     | Only attendance-event review exists                    |
| 44  | Submission sufficient for checkout          | ✅     | (Trivially — the summary is entered at checkout)       |

### 2.6 Task management

| #   | Requirement                           | Status | Notes          |
| --- | ------------------------------------- | ------ | -------------- |
| 45  | Tasks, statuses, assignment, progress | ❌     | Nothing exists |

### 2.7 User experience

| #   | Requirement                        | Status | Notes                                                                                                                                                                                                                |
| --- | ---------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 46  | Desktop layout                     | 🟡     | Current layout is a sidebar + stacked cards; functional but tuned for small screens. Management dashboard exists with summary cards                                                                                  |
| 47  | Mobile experience                  | ✅     | The current design is mobile-first and works well; clock card is thumb-friendly                                                                                                                                      |
| 48  | **Different navigation per role**  | 🟡     | Currently all roles share one nav (Home/History/Profile) with role-conditional content. Employees don't see tasks/reports because those don't exist. Acceptable short-term, needs restructuring for the fuller scope |
| 49  | **PWA (manifest, service worker)** | ❌     | No manifest, no service worker. Geolocation works, but no installability/offline shell                                                                                                                               |
| 50  | GPS feedback on clock card         | 🟡     | Shows errors from `getReading()`, but no accuracy readout or retry guidance                                                                                                                                          |
| 51  | One API for future native apps     | ✅     | BFF pattern is browser-oriented, but the underlying REST API is directly consumable                                                                                                                                  |

### 2.8 Reporting and dashboards

| #   | Requirement                             | Status | Notes                                                                                  |
| --- | --------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| 52  | Org-wide dashboard                      | 🟡     | Present %, on-site, late, to-review counts; sites list. Reasonable but attendance-only |
| 53  | Department summaries                    | ❌     | No departments                                                                         |
| 54  | Task/report pipeline indicators         | ❌     | No tasks/reports                                                                       |
| 55  | Distinguishing missing/pending/verified | ✅     | "Absent" vs "to review" vs "present" is already explicit; good foundation              |

### 2.9 Auditability

| #   | Requirement                       | Status                      | Notes                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 56  | Audit trail for sensitive actions | ✅                          | Both services have `audit_events`; logins, user changes, site changes, map views, reviews are recorded with actor, IP, UA                                                                                                                                                                   |
| 57  | Before/after values               | 🟡                          | `metadata` JSONB exists but most writes store only outcome, not before/after                                                                                                                                                                                                                |
| 58  | **Audit write failures**          | 🔴                          | Audit writes are **best-effort** (`catch → log`) and not part of the business transaction. The doc admits this. For a system where the audit trail may need to satisfy disputes, an outbox pattern or at least transactional audit writes within the same tx is needed for critical actions |
| -   | 59                                | Errors don't leak internals | ✅                                                                                                                                                                                                                                                                                          | Friendly messages, generic auth errors |

### 2.10 Data model and integrity

| #   | Requirement                                          | Status | Notes                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 60  | UUID primary keys                                    | ✅     | `randomUUID()` for all ids                                                                                                                                                                                                                                                                                                          |
| 61  | Foreign keys                                         | 🟡     | Present within each service (sites→events, users→tenants). But `attendance_events.user_id` has **no FK to Identity's users** (cross-service, unavoidable) — instead the roster service validates membership at read time. Acceptable, but the employee identifier that future ERP modules reference should be stable — it is (UUID) |
| 62  | Tenant scoping on every query                        | ✅     | Verified across both services                                                                                                                                                                                                                                                                                                       |
| 63  | UTC storage + Africa/Nairobi display                 | ✅     | timestamptz + per-site timezone for shift logic; portal formats with `Intl`                                                                                                                                                                                                                                                         |
| 64  | Pagination                                           | ❌     | `history?days=`, `GET /v1/users` return unbounded lists. Fine at Eagle One scale for now; add limit/offset when adding departments/tasks                                                                                                                                                                                            |
| 65  | Transactions                                         | 🟡     | `Db.tx()` exists and is used in Identity (create user, reset access, org creation). **Not used in Attendance** — clock-in/out and review are single statements, which is fine for single-row inserts, but the duplicate-check race (item 23) and future multi-step flows need it                                                    |
| 66  | Migrations                                           | ✅     | Plain SQL, applied in order, tracked in `schema_migrations`. Both services.                                                                                                                                                                                                                                                         |
| 67  | Indexes                                              | ✅     | On all foreign-key-shaped and query-path columns in both services                                                                                                                                                                                                                                                                   |
| 68  | History preservation on supervisor/department change | 🟡     | History is event-based so reassignment doesn't rewrite it, but there's no record of _who supervised whom when_                                                                                                                                                                                                                      |

### 2.11 Security posture

| #   | Item                       | Status | Notes                                                                                                                                                                                                                                      |
| --- | -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 69  | Password hashing           | ✅     | Argon2id, OWASP params                                                                                                                                                                                                                     |
| 70  | HTTPS                      | ⚖️     | Compose config has `COOKIE_SECURE` and expects a reverse proxy; actual deployment decisions pending                                                                                                                                        |
| 71  | CSRF                       | ✅     | Origin check on all state-changing requests through the BFF                                                                                                                                                                                |
| 72  | XSS / CSP                  | ✅     | Nonce-based CSP, map popups via text nodes, no `dangerouslySetInnerHTML` found                                                                                                                                                             |
| 73  | SQL injection              | ✅     | Parameterised queries throughout                                                                                                                                                                                                           |
| 74  | Rate limiting              | ✅     | In-memory per-IP (Throttler). Documented limitation: single-instance only                                                                                                                                                                  |
| 75  | File uploads / attachments | ❌     | Nothing exists (work-report attachments are a brief requirement) — must be designed with validation, storage backend, access control                                                                                                       |
| 76  | Secrets management         | ✅     | Env vars only; `.env.example` documented; no secrets in code                                                                                                                                                                               |
| 77  | Kenya DPA 2019 alignment   | 🟡     | Data minimisation is good (location only at clock events, 90-day coordinate retention, no continuous tracking). No consent/notice artifacts, no data-subject export/delete process, no DPIA. Legal review flagged in docs but not yet done |
| 78  | Tenant isolation tested    | ✅     | Test: "keeps organisations separate"                                                                                                                                                                                                       |

### 2.12 Testing

| #                 | Item                          | Status                                          | Notes                                                                                                     |
| ----------------- | ----------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 79                | Service-level automated tests | ✅                                              | 39 tests covering auth, tenancy, clock flows, verification rules, retention, reviews                      |
| 80                | Permission boundary tests     | ✅                                              | Supervisor-scope, tenant-isolation, role tests exist                                                      |
| concurrency tests | ❌                            | The race in item 23 is untested (and unhandled) |
| 82                | Frontend tests                | ❌                                              | None                                                                                                      |
| 83                | E2E browser tests             | 🟡                                              | A 33-step manual smoke test is documented; I re-verified key pages headlessly. No automated browser suite |
| 84                | Real PostgreSQL tests         | ❌                                              | Everything runs on pg-mem; the compose stack was never run. **Highest-priority verification debt**        |

### 2.13 Deployment and operations

| #   | Item                 | Status | Notes                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 85  | Dockerfiles          | 🟡     | Well-structured (multi-stage, non-root, standalone Next). Build and runtime stages verified locally by simulating them. Compose stack untested end-to-end                                                                                                                                                                                                                           |
| 86  | Migrations on deploy | ✅     | Run automatically at service startup, tracked                                                                                                                                                                                                                                                                                                                                       |
| 87  | Backups              | ❌     | No backup/restore runbook. compose has a pgdata volume but no backup tooling or documentation                                                                                                                                                                                                                                                                                       |
| 88  | Logging/monitoring   | 🟡     | Nest Logger to stdout; no structured logs, no correlation ids, no health-based alerting beyond `/health`                                                                                                                                                                                                                                                                            |
| 89  | In-memory state      | 🔴     | **The in-memory dev mode (`start:memory`) is dangerously easy to run in production by accident** — the root `package.json` `dev:*` scripts use it, and the README quick-start leads with it. Data loss on restart is documented, but the risk of someone running the dev script against real staff use is real. Mitigation: production scripts + explicit warnings + startup banner |
| 90  | Tile provider        | ⚖️     | OpenStreetMap public tiles are fine for pilot, not production volume — needs a decision                                                                                                                                                                                                                                                                                             |

---

## Part 3 — Architectural assessment

### What is genuinely good and must be preserved

1. **The token-based service trust model.** Ed25519 access tokens + JWKS + per-service verification is exactly right for a future multi-module ERP. Future modules (inventory, production) can plug in and verify identity without calling Identity.
2. **Per-service databases.** Controversial for a monolith-to-be, but the data ownership boundaries are clean and both services already behave as if they were separable.
3. **The BFF portal.** Browser never touches tokens; allow-listed proxy; Origin checks; nonce CSP. Security architecture is ahead of typical MVP quality.
4. **Append-only attendance events + review decisions.** The integrity model is correct and extensible — corrections can be built _on top_ of it (a correction is a new event referencing the original) rather than fighting it.
5. **Pure verification function.** `evaluate()` is testable, configurable per site, and has a clean seam for adding QR/device-integrity evidence later.
6. **Multi-tenancy from day one.** Every table has `tenant_id`, every query is scoped. Eagle One is one tenant today, but the isolation is free.
7. **Plain SQL migrations, explicit and small.**

### What is structurally missing for the Eagle One brief

1. **Departments** — the biggest data-model gap. The brief's permission model is department-based; the current model is supervisor-list-based only.
2. **Work reports as a first-class entity** — currently a text field on the clock-out event. The brief's section 6 (activities, tasks, quantities, drafts, revisions, reviews) is essentially a new aggregate.
3. **Task management** — entirely absent.
4. **Exception/correction requests** — the system can flag entries automatically but employees cannot _request_ corrections.
5. **Attendance sessions as a concept** — sessions are _derived_ by pairing events at read time. This works but makes reporting queries awkward and will complicate the work-report linkage. A materialised `attendance_sessions` table (open/closed, opened_by_event, closed_by_event) is the natural evolution and preserves the event log.
6. **PWA** — no manifest/service worker.
7. **Pagination** — needed before lists grow.

### Architectural weaknesses to correct

1. **Race condition in clock-in/out** (check-then-insert without a transaction or unique constraint). Fix with a transaction + a partial unique index on open sessions, or `SELECT ... FOR UPDATE` on the user's last event.
2. **Best-effort audit writes** — should be transactional with the business write for critical actions.
3. **Roster call from Attendance to Identity on every team view** (short-TTL cache). Fine for now; the events/outbox pattern in the brief is the eventual replacement. Keep the interface (`Roster` abstract class) — it's already the right seam.
4. **No structured logging / correlation ids** — planned in docs, not implemented.
5. **In-memory dev mode is the default quick-start** — see item 89.

### Should the stack be replaced with Django?

**No.** The brief invites evaluating Django, and the honest answer is that the existing TypeScript/NestJS stack is _sound and suitable_: strict TypeScript, clean module boundaries, explicit SQL, tested verification logic, strong auth/security posture already built. Rewriting to Django would discard working, verified functionality (explicitly warned against in section 16) and buy no architectural benefit — the modular boundaries that matter (identity, attendance, future modules) exist independently of framework. The recommendation is to **retain the stack** and evolve it toward the modular structure the brief describes. The monorepo already has the workspace structure to add modules as packages.

---

## Part 4 — Proposed target data model (delta)

New/changed tables in **Identity** (its scope grows: organisation structure):

```
departments (id, tenant_id, name, code UNIQUE(tenant_id,code), manager_user_id→users, active, created_at)
-- users: + department_id FK→departments (nullable), + job_title, + employment_status history via new table
employee_status_history (id, tenant_id, user_id, status, effective_from, changed_by, reason)
supervisor_assignments (id, tenant_id, supervisor_id, worker_id, assigned_by, assigned_at, ended_at, end_reason)
  -- replaces live-only supervisor_id as the source of truth; users.supervisor_id stays as a current-pointer cache
audit_events: unchanged (already good)
```

New/changed tables in **Attendance**:

```
attendance_sessions (id, tenant_id, user_id, site_id, opened_at, closed_at,
                     open_event_id→attendance_events, close_event_id→attendance_events,
                     status: open|closed|corrected, UNIQUE(tenant_id,user_id) WHERE status='open')
attendance_events: + session_id FK→attendance_sessions (nullable for legacy rows)
attendance_exceptions (id, tenant_id, session_id, event_id, requested_by, type
                      [gps_failure|missed_clockout|emergency|device_failure|other],
                      reason, status[pending|approved|declined], reviewed_by, reviewed_at, review_note, created_at)
work_reports (id, tenant_id, session_id→attendance_sessions UNIQUE, user_id, status[draft|submitted|acknowledged|clarification|rejected],
              submitted_at, revision int, created_at, updated_at)
work_report_items (id, report_id→work_reports, task_id nullable→work_tasks, description,
                   status, quantity numeric, unit, challenges, notes, sort_order)
work_report_revisions (id, report_id, revision, payload jsonb, changed_by, changed_at, reason)
work_report_reviews (id, report_id, reviewer_id, decision[acknowledged|clarification|rejected], note, decided_at)
attachments (id, tenant_id, report_id, filename, mime, size, storage_key, uploaded_by, created_at)
work_tasks (id, tenant_id, title, description, priority, due_date, department_id, assigned_by, assigned_to, status[assigned|in_progress|completed|blocked|cancelled], created_at, updated_at)
task_progress_notes (id, task_id, author_id, note, status_at_time, created_at)
departments mirror / settings table: org_settings (tenant_id, key, value jsonb) for configurable policies
```

Manufacturing fields (product, production line, defective qty, equipment, job ref) go on `work_report_items` as **nullable columns added by a later migration once Eagle One confirms which apply** — not invented now.

## Part 5 — Implementation roadmap

Ordered by dependency, matching the brief's priorities. Each stage ends with tests run and a short report.

**Stage 0 — Verification debt (done, November 2026)**
Real-PostgreSQL integration suites for both services (16 tests: migrations, transactional audit, concurrency races, tenant isolation, pagination); demonstrated backup→restore drill; fail-fast production startup; pagination on user list, history and reviews.

**Stage 1 — Architecture corrections (done, November 2026)**
Clock-in/out transactional (advisory lock, single tx with audit) with race tests; transactional audit for all critical actions; structured JSON logging + correlation IDs end-to-end; role-mapping and physical-verification documents.

**Stage 2 — Organisation structure (Identity) (done, November 2026)**
`departments` table + CRUD (management only, soft deactivation); `users.department_id` + `job_title`; `supervisor_assignments` history table (initial assignment written at user creation, closed-and-reopened on reassignment with reason); `employee_status_history` with session revocation on deactivation; all critical actions transactionally audited; covered by Stage-2 pg-mem tests plus a real-DB test over constraints, history integrity and audit rows.

**Stage 3 — Attendance sessions + exceptions (Attendance, next)**
`attendance_sessions` materialisation; backfill from event history; session-based history endpoint (keeps API shape); employee-initiated `attendance_exceptions` with supervisor/management review; management override action (audited).

**Stage 4 — Work reports (Attendance)**
`work_reports`/`items`/`revisions`/`reviews` entities; draft → submit → acknowledge/clarify/reject flow; checkout rule becomes "session has a submitted report" (keeping today's behaviour as fallback for legacy sessions); report detail for worker (own) and reviewer; multi-day task linkage.

**Stage 5 — Tasks (Attendance)**
Task CRUD with department/supervisor scoping, statuses, progress notes; link task → report items.

**Stage 6 — Portal**
Rebuild nav per role; management dashboard with department summaries (once departments exist); report and task screens; PWA manifest + service worker (installable, offline shell for read-only pages); mobile-first clock flow polish; GPS accuracy feedback.

**Stage 7 — Reporting/analytics**
Org and department-level aggregates (SQL rollups, not fabricated); distinguish missing/pending/verified states consistently (already a strength — extend it).

**Stage 8 — Security/privacy hardening**
Attachment upload pipeline (type/size validation, private storage, signed access); CSP to enforce mode after real-device testing; DPA artifacts (privacy notice, retention config, data-export/deletion process); DPIA skeleton.

**Stage 9 — ERP foundations**
Outbox table + event publishing (EmployeeCreated, AttendanceCheckedIn/Out, WorkReportSubmitted/Reviewed); versioned API convention (`/v1` already); stable identifiers documented as the integration contract.

**Stage 10 — Deployment**
Compose prod profile, reverse-proxy TLS config, monitoring hooks, restore drill, deployment documentation.

## Part 6 — Decisions required from Eagle One

| #   | Decision                             | Default I will use until confirmed                                                                            |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 1   | Actual workplace GPS coordinates     | None stored; management enters via Sites UI                                                                   |
| 2   | Geofence radius                      | 150 m default, configurable per site                                                                          |
| 3   | Acceptable GPS accuracy              | 100 m default, configurable                                                                                   |
| 4   | Employee ID format                   | Current freeform staff number kept                                                                            |
| 5   | Department structure and names       | Empty; management creates via UI                                                                              |
| 6   | Supervisor-to-employee assignments   | Empty; management assigns via UI                                                                              |
| 7   | Working schedules/shifts             | Per-site shift start + grace (already configurable); no shift templates until confirmed                       |
| 8   | Overtime / late-arrival rules        | Late = after shift+grace (current rule); overtime not modelled yet                                            |
| 9   | Supervisor verification procedure    | Review of flagged entries only, no on-site attestation action yet                                             |
| 10  | Attendance correction policy         | Exceptions require reason + supervisor approval; no silent edits                                              |
| 11  | Work-report retention                | Indefinite for reports; 90-day coordinate purge (configurable)                                                |
| 12  | Manufacturing-specific report fields | Not added until confirmed which apply                                                                         |
| 13  | Account provisioning                 | Supervisors add workers; management adds supervisors; platform owner adds admins (current design, works well) |
| 14  | Data retention / privacy procedures  | Coordinates 90 days; full DPA review pending legal                                                            |
