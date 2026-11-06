# Attendance Service specification (v0.1)

## Responsibilities
Sites and boundaries, clock-in and clock-out decisions, work reports, history, team board, locations map, review of flagged entries, retention of coordinates.
Identity owns people; Attendance owns attendance. Attendance verifies Identity's tokens with its public key (JWKS) and asks Identity for the caller's team (`GET /v1/users`, using the caller's own token, so Identity enforces who may see whom).

## Endpoints (all need a valid access token)
| Method and path | Roles | Purpose |
|---|---|---|
| `GET /v1/attendance/state` | all | Clocked in or out, since when, sites |
| `POST /v1/attendance/clock-in` | all | `{siteId?, reading?, requestReview?}` |
| `POST /v1/attendance/clock-out` | all | Same, plus required `workSummary` (10 to 2000 characters) |
| `GET /v1/attendance/history?days=` | all | Own sessions (clock-in paired with clock-out) with work done |
| `GET /v1/sites` | all | Workers get names only; others get full boundaries |
| `POST /v1/sites`, `PUT /v1/sites/:id` | management, admin | Site boundary, shift, grace, accuracy limit, staff network |
| `GET /v1/team/attendance?date=` | supervisor, management, admin | Board for a day: present, late, absent, to review, with work reports |
| `GET /v1/team/map?date=` | same | Pinpointed clock-in/out points for the caller's team (audited) |
| `GET /v1/team/reviews` | same | Entries waiting for a decision, with reasons |
| `POST /v1/attendance/events/:id/review` | same | `approved` or `declined` |

## Server-side decision (per clock-in and clock-out)
| Situation | Outcome |
|---|---|
| Inside the boundary, accuracy within the site limit, no flags | accepted |
| Inside the boundary of uncertainty, or accuracy worse than the limit | review |
| Clearly outside (distance minus accuracy exceeds the radius) | declined |
| No usable location | declined (worker may ask for review) |
| Network not recognised | review, or declined when the site requires the staff network |
| Reading older than two minutes, accuracy under 1 m | review |
| Travel faster than 200 km/h since the last event, or identical coordinates across the last three events | review |
A declined worker can resubmit with `requestReview`, which records the entry for a supervisor instead of leaving them stuck. The worker sees the result and what to do next, never which check fired. Supervisors see the reasons.

## Data
`sites`, `attendance_events` (append-only; corrections are review decisions, never edits), `audit_events`. Coordinates are erased after `RETENTION_DAYS`; distance and outcome remain. Day boundaries use `TZ_OFFSET_MINUTES` (Kenya: 180); lateness uses each site's own time zone, shift start and grace period.

## Limits
A browser's location can be faked by a determined person and the server cannot see through that. The staff-network check (a fixed public IP) is the one signal the server observes itself, so use it where possible. Tune thresholds from real data during the pilot.
