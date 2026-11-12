# ERP Platform v0.2 — PresenceHub

A modular ERP platform: each business module is its own microservice, and every module trusts one shared identity.

**Developer & maintainer:** JUSTKIM

```
frontend/portal-web      Next.js portal: login, role-based home/history/profile, team, map, sites
backend/identity         Organisations, users, activation, login, sessions, roles, platform endpoints, audit
backend/attendance       Clock in/out with server-side verification, work reports, team board, map, reviews
docs/                    Deployment guide, local-testing guide, security & UX reviews, specs, ADRs, roadmap
docker-compose.yml       PostgreSQL + Identity + Attendance + Portal
```

## What it does

- **People are added by supervisors in the UI.** Employees receive a one-time activation code and choose a PIN (workers) or password on first login. Secrets are stored only as Argon2id hashes. A forgotten PIN is reset by the supervisor (new code), never read out.
- **Administrators are added through hidden platform endpoints** (`/v1/platform/...`), protected by a bootstrap token and optional IP allow-list. Nobody ever sees an administrator's password.
- **Clock in/out is decided by the server** from location, site boundary, accuracy, staff network IP (optional), and plausibility rules: accepted, accepted for review, or declined with plain guidance.
- **Clock-out carries a required work report.**
- **Supervisors see their team's clock points on a map**, review flagged entries, and read reports. Map views are audited; coordinates are erased after `RETENTION_DAYS` (default 90).
- Passkey (WebAuthn) confirmation of clock-ins for enrolled workers.

---

## Local development

Requires **Node 22+**. No Docker needed for day-to-day work.

```bash
npm install
npm run dev:identity     # terminal 1: Identity on :3001, in-memory database
npm run dev:attendance   # terminal 2: Attendance on :3002, in-memory database
IDENTITY_URL=http://localhost:3001 ATTENDANCE_URL=http://localhost:3002 DEFAULT_ORG=<slug> npm run dev:portal   # terminal 3
```

> In-memory mode is development-only: data lives in RAM and is lost on restart.
> It can never start in production (`NODE_ENV=production` without `DATABASE_URL`
> and `SIGNING_KEY_JWK` blocks startup).

Nothing is seeded by default. Create a development organisation with:

```bash
DEV_SEED_ORG=1 npm run dev:identity   # prints a one-time administrator activation code
```

Open http://localhost:3000 → **Set up your access** → enter the staff number and code → choose your own password/PIN.

### Testing

```bash
npm test              # fast suites on pg-mem: Identity 19 tests, Attendance 20 tests
npm run test:pg       # real-PostgreSQL suites (migrations, transactions, concurrency)
npm run typecheck
npm run build
```

The real-DB suites need a database. Start an isolated disposable instance on port 5544:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-db-init.ps1
$env:TEST_DATABASE_URL = 'postgres://postgres@127.0.0.1:5544/identity_test'
$env:TEST_DATABASE_URL = 'postgres://postgres@127.0.0.1:5544/attendance_test'
npm run test:pg
```

Without `TEST_DATABASE_URL` those tests report as **skipped**, never silently passed.

### Load testing (optional, local-only harness)

`scripts/perf/` (git-ignored) contains a reusable harness that seeds 3,000 users
through the real API and drives morning-rush / steady-state / supervisor-burst
scenarios. See `scripts/perf/README.md`.

---

## Deployment

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — the single go-live guide covering
environment configuration, TLS, the compose stack, seed, backup/restore drills, the
production-readiness gate, and the phased rollout plan.

Quick version:

```bash
cp .env.example .env
npm run gen-key -w @platform/identity     # paste output into SIGNING_KEY_JWK in .env
# set PLATFORM_BOOTSTRAP_TOKEN (≥32 random bytes), POSTGRES_PASSWORD, DEFAULT_ORG
docker compose up --build
PLATFORM_BOOTSTRAP_TOKEN=... ORG_NAME="Your Company" ORG_SLUG=yourco ADMIN_STAFF_NUMBER=0001 ADMIN_NAME="Your Name" \
  npm run seed -w @platform/identity      # prints the administrator's one-time code
```

---

## Current verification status

| Area | Status |
|---|---|
| Behaviour correctness | 71 automated e2e tests passing (39 Identity + 32 Attendance), plus 17 real-DB tests (migrations, concurrency) runnable with `npm run test:pg`; CI-gated |
| Resilience & offline | Offline clock-event queue with drain-on-reconnect; BFF circuit breaker + upstream timeouts; compose restart policies |
| Privacy | Full privacy notice at `/privacy` linked from login, activation, and profile; audit-log retention job |
| Load | 3,000-user harness: 0 errors, hot DB queries 0.1–0.2 ms; login is CPU-bound → scale Identity horizontally |
| Docker stack | Defined and compose-validated; **first end-to-end run pending** (see deployment guide Phase A) |
| Browser/device | Desktop-tested; real-phone walk-through pending (deployment guide Phase C) |
| Security | Audit retention, timing-equalised refresh, WebAuthn clone detection shipped; see `docs/SECURITY-REVIEW-2026-11-10.md` |

Known next steps live in `docs/ROADMAP.md`.
