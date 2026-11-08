# ERP Platform v0.2: Identity, Attendance and Portal

A modular ERP platform in which each business module is its own microservice and every module trusts one shared identity.

**Developer & maintainer:** JUSTKIM. All roadmap work in `docs/ROADMAP.md` is owned and executed by the developer; see `docs/DEVELOPER-GUIDE.md` for the workflow and `docs/PRODUCTION-CHECKLIST.md` for the go-live runbook.

```
apps/portal-web        Next.js web app: log in, role-based Home / History / Profile, team, locations map, sites
services/identity      Organisations, users, first-time setup, login, sessions, roles, hidden platform endpoints, audit
services/attendance    Clock in / clock out with server-side location verification, work reports, team board, map, reviews
docs/                  Architecture, service specifications, security, decision records
docker-compose.yml     PostgreSQL + Identity + Attendance + Portal
```

## What it does

- **People are added by supervisors in the UI.** The employee receives a one-time activation code, chooses a **PIN (workers) or password** on their first log in, and afterwards just logs in. Secrets are stored only as Argon2id hashes. A forgotten PIN is reset by the supervisor (new code), never by someone reading it out.
- **Real administrators are added through hidden platform endpoints** (`/v1/platform/...`), protected by a bootstrap token and an optional IP allow-list. The platform owner never sees an administrator's password: the administrator sets it on first log in.
- **Clock in and clock out are decided by the server** from the browser's location, the site boundary, the reading's accuracy, the staff network address (optional) and plausibility rules. Outcomes: accepted, accepted for review, or declined with plain guidance. A declined worker can ask a supervisor to review.
- **Clock-out comes with a work report.** The note on what was done is required and visible to supervisors.
- **Supervisors see the team's clock-in and clock-out points on a map** (their own team only), review flagged entries, and read work reports. Every map view is audited, and exact coordinates are erased after `RETENTION_DAYS` (default 90).

## Quick start (no Docker, Node 22+)

```bash
npm install
npm run dev:identity     # terminal 1: Identity on :3001, in-memory database (empty; see quick start below)
npm run dev:attendance   # terminal 2: Attendance on :3002, in-memory database
IDENTITY_URL=http://localhost:3001 ATTENDANCE_URL=http://localhost:3002 DEFAULT_ORG=<your-org-slug> npm run dev:portal   # terminal 3
```

> **In-memory mode is for development only.** It holds all data in RAM and loses
> everything on restart. It can never start in production: `NODE_ENV=production`
> without a real `DATABASE_URL` (and, for Identity, `SIGNING_KEY_JWK`) blocks the
> process at startup with explicit errors. Production starts are
> `npm run start:identity` / `start:attendance` / `start:portal` or the Docker images.

Open http://localhost:3000. By default nothing is seeded — the service starts empty.
To create your development organisation, run terminal 1 as:

```bash
DEV_SEED_ORG=1 npm run dev:identity   # prints a one-time activation code for the administrator
```

Then open the portal, choose **Set up your access**, enter the staff number and the
activation code that was printed once in terminal 1, and choose your own password or
PIN. No shared demo password exists anywhere in the codebase. Pass the organisation
slug to the portal with `DEFAULT_ORG=<slug>` (or `?org=<slug>` on the sign-in URL).
In-memory databases reset on restart and are for development only.

## Run with Docker (real PostgreSQL)

```bash
cp .env.example .env
npm run gen-key -w @platform/identity     # paste the output into SIGNING_KEY_JWK in .env
# set PLATFORM_BOOTSTRAP_TOKEN to a long random string
docker compose up --build
PLATFORM_BOOTSTRAP_TOKEN=... ORG_NAME="Your Company" ORG_SLUG=yourco ADMIN_STAFF_NUMBER=0001 ADMIN_NAME="Your Name" \
  npm run seed -w @platform/identity      # prints the administrator's one-time activation code
```
Open the portal (with `DEFAULT_ORG=yourco` in `.env`), choose **Set up your access**, and enter the code. Add more real users with
`PLATFORM_BOOTSTRAP_TOKEN=... node services/identity/scripts/platform-add-user.mjs yourco 0200 "Full Name" supervisor`.

## Tests

```bash
npm test            # Identity (19 tests + 7 real-DB) and Attendance (20 tests + 9 real-DB)
```

The fast suites run on pg-mem (no database needed). The real-PostgreSQL suites
(`npm run test:pg`) exercise migrations, transactions and concurrency against a real
database — they need one running:

```powershell
# one-time: start an isolated test instance on port 5544 (uses .pgtest/, disposable)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-db-init.ps1
$env:TEST_DATABASE_URL = 'postgres://postgres@127.0.0.1:5544/identity_test'
$env:TEST_DATABASE_URL = 'postgres://postgres@127.0.0.1:5544/attendance_test'
npm run test:pg
```

Real-database tests are skipped (reported as skipped, not passed) when
`TEST_DATABASE_URL` is unset.

```bash
npm run typecheck
npm run build
```

## What is and is not verified yet

| Area | Status |
|---|---|
| Identity and Attendance behaviour | Covered by 39 automated end-to-end tests |
| Whole system through the portal (onboarding, PIN and password set-up, clock in/out, work report, map data, review, reset access, CSRF, session renewal, log out) | 33-step smoke test passed against the running services |
| Database | Tests and smoke test use `pg-mem`, an in-memory PostgreSQL emulator. **Run against real PostgreSQL before relying on it** |
| Browser behaviour (geolocation prompt, map rendering, phone layouts, CSP) | **Not tested in a real browser** here. Test on real phones, then set `CSP_MODE=enforce` |
| Dockerfiles and `docker-compose.yml` | Written, **not run** (no Docker in the build environment) |
| Staff-network (IP) check | Logic tested; needs the correct `TRUST_PROXY` chain and a static public IP on the real deployment |

## Known gaps and next steps

1. Real PostgreSQL in CI; run the Docker stack; browser and device testing.
2. Notifications service (email, SMS) and events between services (RabbitMQ), replacing the team-directory call from Attendance to Identity.
3. Missing clock-out corrections, user deactivation, shifts per employee, reports and exports.
4. Redis-backed rate limiting before running more than one instance of a service.

Workers can register passkeys in Profile. Once enrolled, a passkey is required to confirm each clock-in; PIN/password login remains available. Configure `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` for the portal's real HTTPS host before production use.
