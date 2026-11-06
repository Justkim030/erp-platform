# Stage 2 completion report — Organisation structure (Identity)

**Date:** 4 November 2026 · **Scope:** departments, supervisor-assignment history,
employee status history. No Attendance-side changes.

## What was built

### Migration `003_organisation_structure` (Identity)

| Table/Change | Purpose |
|---|---|
| `departments` | Name, optional code (unique per tenant when set), manager user reference, `active` flag (soft deactivation — history is never lost) |
| `users.department_id`, `users.job_title` | Department membership and job title |
| `supervisor_assignments` | Historical source of truth for who supervised whom and when: `assigned_at`, `assigned_by`, `ended_at`, `end_reason`; `CHECK (supervisor_id <> worker_id)`; open-assignment index |
| `employee_status_history` | Every status change with previous status, who changed it, why, and the correlation id |

`users.supervisor_id` remains the fast "current supervisor" pointer, now kept in sync
by the reassignment flow inside the same transaction.

### Endpoints (all tenant-scoped, route- and object-level enforced)

| Route | Roles | Behaviour |
|---|---|---|
| `GET /v1/departments[?includeInactive=true]` | management, admin | Active list (or all) |
| `POST /v1/departments` | management, admin | Create; 409 on duplicate name or code (constraint surfaced cleanly) |
| `PUT /v1/departments/:id` | management, admin | Update |
| `POST /v1/departments/:id/deactivate` | management, admin | Soft deactivation |
| `POST /v1/workers/:id/supervisor` | management, admin | Reassign with reason; closes the open assignment row, opens a new one, updates the pointer — one transaction, one audit row |
| `GET /v1/workers/:id/assignments` | supervisor (own team), management, admin | Assignment history |
| `POST /v1/users/:id/status` | management, admin | `active`/`deactivated`; deactivation revokes all sessions immediately; history + audit in the same tx |
| `GET /v1/users/:id/status-history` | supervisor (own team), management, admin | Status history |

### Behaviour integrated with existing flows

- **User creation** now optionally takes `departmentId` (validated against the tenant)
  and, when a supervisor is assigned, writes the **initial `supervisor_assignments`
  row** in the same transaction.
- **Reassignment is idempotent-safe**: reassigning to the same supervisor is a no-op
  (`changed: false`); concurrent reassignments are serialised with a transaction-scoped
  advisory lock.
- **Deactivation** revokes refresh sessions immediately (the same mechanism as access
  reset), records `previous_status`, and blocks login. Reactivation appends to history;
  the old session stays revoked (users must log in again — deliberate).
- **Self-protection rules**: nobody can change their own status; management cannot
  deactivate other management/admin accounts (admin can); supervisors cannot create
  departments or reassign workers.

### Transactional audit (extends Stage 1)

`department.created/updated/deactivated`, `worker.reassigned` (with
`previousSupervisorId`, `newSupervisorId`, reason), `user.status_changed` (with
`previousStatus`, `newStatus`, reason) — all written inside the business transaction.

## Testing

| Suite | Environment | Result |
|---|---|---|
| Identity unit: 19 (Stage 0/1) + **14 new Stage 2** | pg-mem | **33 pass**, 7 real-DB skipped |
| Identity real-DB: 7 (Stage 0/1) + **1 new Stage 2** (comprehensive: constraints 409s, department on worker, reassignment history 2 rows closed+open, status history, soft deactivation, 4 audit actions verified in DB) | real PostgreSQL 18.4 | **8 pass** |
| Attendance unit (20) + real-DB (9) | pg-mem / real PG | **unchanged, all pass** |
| Typecheck, build | — | **clean** |

## Honest notes

1. **pg-mem quirks discovered and worked around:** pg-mem does not enforce the unique
   constraints in this configuration (duplicate-name/code tests moved to real-DB),
   and showed a query-visibility anomaly on a joined history read after a
   transactional update (that assertion also moved to real-DB, where it passes).
   Both are documented in the test files. The real-DB suite is authoritative for
   persistence semantics — as intended since Stage 0.
2. **One real bug found and fixed by the real-DB suite:** duplicate department
   name/code raised an unhandled 500 instead of 409. Now caught (`23505` →
   `ConflictException`) and covered by tests.
3. The portal UI does not yet surface departments (management creates them via API);
   UI wiring belongs to the Stage 6 portal rebuild, per the roadmap.

## Unresolved business decisions (unchanged defaults, now configurable in-system)

- Department names/structure: empty until Eagle One creates them in the UI/API.
- Supervisor-to-employee assignments: empty until management assigns.
- Deactivation policy (when to deactivate vs. reset access): current default is that
  deactivation is an explicit management action with a recorded reason.

**Stage boundary:** stopping here for review before Stage 3 (attendance sessions +
exception workflows in the Attendance service).
