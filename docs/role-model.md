# Role model — what each role can and cannot do

**Status:** accurate as of the Stage 0/1 corrections (Nov 2026). This document is the
reference for how authorisation actually works in code today. Do not silently change
role semantics; extend deliberately.

## The four roles

| Role         | Scope                               | Purpose                                                                       |
| ------------ | ----------------------------------- | ----------------------------------------------------------------------------- |
| `worker`     | Own records only                    | Frontline employee: clocks in/out, views own history and profile              |
| `supervisor` | Assigned employees only             | Manages a team: sees their attendance, reviews flagged entries                |
| `management` | Whole organisation (tenant)         | Oversight and configuration: all employees, sites, dashboards                 |
| `admin`      | Whole organisation + platform setup | Organisation administrator; the only role that can create management accounts |

There are **four** roles, not three. `admin` and `management` are deliberately
distinct: `admin` is the tenant's administrative owner (can also add admins and
management), while `management` is an operational oversight role. Both currently
have organisation-wide read access, but only `admin` (and the hidden platform
endpoints) can create admin/management accounts. **They must not be merged** —
fine-grained management permissions will be introduced within `management` later.

## What each role can do (by endpoint)

### Identity service

| Operation                           | worker | supervisor                                | management              | admin               |
| ----------------------------------- | ------ | ----------------------------------------- | ----------------------- | ------------------- |
| Login/activate/refresh/logout/reset | ✓      | ✓                                         | ✓                       | ✓                   |
| `GET /v1/me` (own profile)          | ✓      | ✓                                         | ✓                       | ✓                   |
| `GET /v1/users`                     | —      | ✓ own team only                           | ✓ org-wide              | ✓ org-wide          |
| `POST /v1/users` (add employee)     | —      | ✓ **workers only**, auto-assigned to self | ✓ workers + supervisors | ✓ all roles         |
| `POST /v1/users/:id/reset-access`   | —      | ✓ own workers only                        | ✓ workers + supervisors | ✓ all (except self) |

Platform endpoints (`POST /v1/platform/organisations[/:slug/users]`) are not
role-based at all: they answer 404 unless the `x-bootstrap-token` matches (and,
when configured, the caller IP is allow-listed). No UI uses them. This is
**platform administration** — distinct from any organisation role.

### Attendance service

| Operation                                               | worker       | supervisor | management | admin      |
| ------------------------------------------------------- | ------------ | ---------- | ---------- | ---------- |
| `GET /v1/attendance/state`                              | ✓            | ✓          | ✓          | ✓          |
| `POST /v1/attendance/clock-in` / `clock-out`            | ✓            | ✓          | ✓          | ✓          |
| `GET /v1/attendance/history`                            | ✓ own only   | ✓ own only | ✓ own only | ✓ own only |
| `GET /v1/sites`                                         | ✓ names only | ✓ full     | ✓ full     | ✓ full     |
| `POST/PUT /v1/sites`                                    | —            | —          | ✓          | ✓          |
| `GET /v1/team/attendance`, `/team/map`, `/team/reviews` | —            | ✓ own team | ✓ org-wide | ✓ org-wide |
| `POST /v1/attendance/events/:id/review`                 | —            | ✓ own team | ✓ org-wide | ✓ org-wide |

## How the two enforcement layers work

**Route-level** (`RolesGuard` + `@Roles(...)` decorators): decides whether a role may
call an endpoint at all. Example: `POST /v1/sites` rejects `supervisor` and `worker`
before any business logic runs.

**Object-level** (inside service code): decides which _rows_ a caller may see or act
on. This is what stops a supervisor from widening their own access:

- `Identity listUsers`: a supervisor's query is filtered by
  `supervisor_id = actor.sub`; management/admin filter only by tenant.
- `Identity resetAccess`: explicit permission matrix — supervisor only for their own
  workers; management for workers/supervisors; admin for anyone but not themselves.
- `Attendance teamEvents`: the roster (from Identity, using the caller's own token)
  is filtered to `worker`/`supervisor` roles, and every event query is restricted to
  those member ids. A supervisor cannot see another supervisor's team even by
  guessing ids, because the review endpoint re-checks `members.some(m => m.id === e.user_id)`.
- **Tenant isolation is absolute**: every query in both services carries `tenant_id`
  from the verified token, never from input. Cross-tenant ids are simply not found (404).

## Extensibility for future fine-grained permissions

The token currently carries `role` as a single claim. Planned evolution (Stage 2+):
department-scoped management roles and permission checks keyed on department
membership. The seam for this is the `RolesGuard` + per-service object-level checks:
add claims (e.g. `dept`, `perms[]`) without changing route decorators, and extend
object-level filters to include department scope. Nothing in the current model
blocks this; do not add new role strings ad hoc — extend the model deliberately.

## Known limitation (documented, by design)

Access tokens are short-lived (10 min) and carry the role at issue time. A role or
status change takes effect at the next refresh, not instantly. Revocation of a
session kills refresh capability immediately; the current access token lives out its
10 minutes. This is an accepted trade-off for local verification (no per-request
Identity call) and is unchanged in this stage.
