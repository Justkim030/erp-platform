# Developer Guide — ERP Platform v0.2

**Developer & maintainer: JUSTKIM**

This is your operating manual: how the codebase is laid out, how to work on it day to day, and exactly what to do next. The prioritised backlog lives in `docs/ROADMAP.md`; the go-live runbook is `docs/PRODUCTION-CHECKLIST.md`.

---

## 1. Who does what

| Role                                 | Owner       | Responsibility                                                |
| ------------------------------------ | ----------- | ------------------------------------------------------------- |
| Developer & maintainer               | **JUSTKIM** | All code, tests, docs, deployments; owns every roadmap item   |
| Platform owner (you, when operating) | JUSTKIM     | Holds `PLATFORM_BOOTSTRAP_TOKEN`, runs seed, approves go-live |

## 2. Project layout (what lives where)

```
apps/portal-web          Next.js portal (frontend). Never talks to the browser with tokens.
  app/                   Pages + route handlers (app router)
    (app)/               Signed-in pages: home, history, team, map, sites, profile
    api/auth/*           login, activate, logout, session — cookie setters
    api/svc/[service]/   BFF proxy to the microservices (allow-listed paths only)
  components/            UI components (ClockCard, TeamMap, SiteEditor, …)
  lib/                   identity.ts (service client), session.ts (cookies), origin.ts (CSRF)
services/identity        NestJS microservice: orgs, users, auth, roles, platform endpoints
  src/main.ts            bootstrap + production config validation
  src/security.ts        argon2id, JWT/JWKS, invite codes
  src/guards.ts          JwtGuard, RolesGuard, PlatformGuard
  src/db.ts              pool + tx + migration runner
services/attendance      NestJS microservice: sites, clock in/out, verification, reviews
  src/verification.ts    pure server-side geo/IP logic (unit-testable)
docs/                    All documentation (this guide, audit, checklist, specs, ADRs)
scripts/                 PowerShell helpers (pg-probe, restore-drill, test-db-init)
infra/postgres/init.sql  Creates the separate attendance database
```

## 3. Daily workflow

1. **Start of session**
   ```powershell
   Set-Location c:\Users\HomePC\Desktop\erp-platform-v0.2
   git status            # confirm clean tree
   git pull              # when a remote exists
   ```
2. **Branch per task**: `git switch -c fix/B-1-xff-sanitisation` (name = roadmap ID).
3. **Run the stack locally**
   ```powershell
   DEV_SEED_ORG=1 npm run dev:identity    # terminal 1 — prints a one-time activation code
   npm run dev:attendance                 # terminal 2
   IDENTITY_URL=http://localhost:3001 ATTENDANCE_URL=http://localhost:3002 DEFAULT_ORG=<slug> npm run dev:portal   # terminal 3
   ```
4. **Before every commit** — all three must be green:
   ```powershell
   npm run test; npm run typecheck; npm run build
   ```
5. **Commit style**: `B-1: sanitise x-forwarded-for in BFF proxy` — roadmap ID first.
6. **End of task**: tick the row in `docs/ROADMAP.md`, update the relevant `docs/*.md`, open a PR into `main` (even solo — it's your review trail).

## 4. Your exact next steps (do these in order)

This is your current TODO list, taken from the roadmap. One item per branch.

### Step 1 — B-3: put the project under version control — ✅ done 2026-11-06

- Baseline commit pushed to **https://github.com/Justkim030/erp-platform** (private, default branch `master`, commits authored by `JUSTKIM <Justkim030@users.noreply.github.com>`).
- `git ls-files` audit passed: no `.env`, dumps, logs, `.pgtest/`, `node_modules`, `dist`, `.next`, or `*.tsbuildinfo` in the index.
- Repo-local identity pinned to Justkim030; `gh` active account is Justkim030.

Remaining:
- [ ] Move `backups/*.dump` and `.pgtest/` to `C:\erp-artifacts\` (live employee data — ignored, but keep them off the project folder).

### Step 2 — B-1: sanitise `x-forwarded-for` in the BFF — ✅ implemented

- [x] The BFF ignores browser-supplied forwarding headers and forwards only a validated IP supplied by the trusted Next.js adapter.
- [x] If no trusted adapter IP is available, no client IP is forwarded; confirm the deployed edge and proxy-hop configuration before relying on IP rules.

### Step 3 — B-2: global exception filter — ✅ implemented

- [x] Both services return correlated JSON errors and log server failures with the correlation id.
- [x] Regression tests assert correlated errors.

### Step 4 — B-4: strong bootstrap token check — ✅ implemented

- [x] Identity requires a present, at-least-32-byte token in production; tests cover missing and short values.

### Step 5 — B-5: health endpoints + compose healthchecks — ✅ implemented

- [x] Liveness/readiness endpoints and container healthchecks are in place; Attendance readiness checks the Identity JWKS endpoint.

### Step 6 — N-1: rate limiting on the portal auth routes (1 day)

- [ ] `apps/portal-web/lib/rate-limit.ts`: in-memory token bucket keyed by IP (e.g. 10 attempts / 5 min on login & activate).
- [ ] Return 429 — the frontend already renders the friendly "too many attempts" message.

### After that

Continue down `docs/ROADMAP.md` (N-3 → N-6, then 🟢 items). Then run the full go-live runbook in `docs/PRODUCTION-CHECKLIST.md` Phases 2–6.

## 5. Rules to protect yourself (and the data)

- **Never** commit `.env`, dumps, or logs. Check `git status` before every commit.
- **Never** add a hardcoded password or seed to production code paths. New demo data belongs behind an explicit opt-in env flag or in `test/`.
- **Never** log tokens, passwords, or personal data — `log.ts` fields only.
- Every new endpoint needs: a DTO with validation, a guard (`@Roles(...)` or platform), an audit row for state changes, and a test.
- Schema changes go through `migrations.ts` — never edit an applied migration; append a new one.
- When you're unsure where code belongs: pure logic → a standalone module (`verification.ts`-style); HTTP shape → controllers; DB → services; never leak SQL into controllers.

## 6. Escalation / when stuck

- Architecture questions → `docs/architecture.md` and `docs/adr/`.
- Security posture → `docs/security.md` + `docs/PRODUCTION-AUDIT.md`.
- If a production incident: capture logs first, then `git revert` the offending commit — the roadmap's definition of done (tests green + docs updated) keeps every commit revertible.
