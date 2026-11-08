# Production Go-Live Checklist — ERP Platform v0.2

Follow these steps **in order**. Tick each box as you complete it. Companion documents: `docs/PRODUCTION-AUDIT.md` (findings), `docs/ROADMAP.md` (backlog).

---

## Phase 0 — Repository hygiene (do today)

### 0.1 Put the project under version control

- [ ] Run `git init` in the project root.
- [ ] Review `.gitignore` (already covers `.env`, `*.log`, `node_modules`, `dist`, `.next`).
- [ ] `git add -A` → inspect `git status` → confirm no `.env`, `.dump`, or `.log` files are staged.
- [ ] `git commit -m "baseline v0.2"` and add a remote (`git remote add origin <url>`, `git push -u origin main`).
- [ ] From now on: one branch per change, PR into `main`.

### 0.2 Evict runtime artifacts

- [ ] Create a folder **outside** the project, e.g. `C:\erp-artifacts\`.
- [ ] Move `*.log`, `qa-standalone*/`, `pw-install*.log`, `npm-ci.log` there (or delete them — they're disposable logs).
- [ ] Move `.pgtest\` (a real PostgreSQL data directory) and `backups\*.dump` to `C:\erp-artifacts\` — these contain live employee data.
- [ ] Add to `.gitignore`: `.pgtest/`, `backups/`, `qa-standalone*/`.
- [ ] Commit the `.gitignore` change.

## Phase 1 — Code fixes

### 1.1 Global exception filter (both services) — ✅ implemented

- [x] Both services return JSON errors with the request correlation id; 5xx failures are logged with that id.
- [x] Identity and attendance tests cover correlated error responses.

### 1.2 Strong production bootstrap token — ✅ implemented

- [x] Identity requires `PLATFORM_BOOTSTRAP_TOKEN` to be set and at least 32 bytes. Attendance does not use this platform-owner credential.
- [x] Tests cover missing and short tokens.

### 1.3 Sanitised BFF client IP — ✅ implemented

- [x] The BFF ignores browser-provided `x-forwarded-for` and forwards only a validated IP supplied by the trusted Next.js adapter. Without such an IP, it forwards none.
- [x] Confirm the deployed proxy and `TRUST_PROXY` hop count before enabling attendance network rules.

### 1.4 Rate-limit portal auth routes

- [ ] Add a small token-bucket helper `apps/portal-web/lib/rate-limit.ts` keyed on IP for `/api/auth/login`, `/activate`, and the svc proxy.
- [ ] Return 429 with the same friendly message the frontend already handles.

### 1.5 Health endpoints + compose healthchecks — ✅ implemented

- [x] Identity and attendance expose `/healthz` and `/readyz`; readiness checks DB and Identity JWKS availability.
- [x] Compose healthchecks cover identity, attendance, and portal; Attendance waits for healthy Identity.

## Phase 2 — Environment configuration

- [ ] `Copy-Item .env.example .env`
- [ ] `npm run gen-key -w @platform/identity` → paste JSON into `SIGNING_KEY_JWK` (one line).
- [ ] Set `PLATFORM_BOOTSTRAP_TOKEN` to a ≥ 32-char random string (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`).
- [ ] Generate a strong `POSTGRES_PASSWORD` (not `platform`).
- [ ] `PLATFORM_ALLOWED_IPS` = the operator's office/VPN IP.
- [ ] `COOKIE_SECURE=true` and `CSP_MODE=enforce` once the site is behind HTTPS.
- [ ] Set `MAP_TILE_URL` to an HTTPS tile provider authorized for the app. `MAP_TILE_API_KEY` is sent to browsers, so restrict it by domain; include provider and OpenStreetMap attribution in `MAP_TILE_ATTRIBUTION`.
- [ ] Set `WEBAUTHN_RP_ID` to the portal's registrable domain and `WEBAUTHN_ORIGINS` to its exact HTTPS origin(s); never use the localhost defaults for production.
- [ ] Set `TRUST_PROXY` to the real number of proxies (portal-only = 1; reverse proxy + portal = 2).
- [ ] `.env` must never be committed — verify with `git status`.

## Phase 3 — Deployment verification

- [ ] `docker compose up --build` — all services start; identity logs `STARTUP` without "STARTUP BLOCKED".
- [ ] `curl http://localhost:3001/readyz` and `:3002/readyz` return 200.
- [ ] Log in via the portal at `http://localhost:3000`, clock in/out, review history.
- [ ] Confirm JSON logs on stdout are one-object-per-line and contain no tokens/PII.
- [ ] Negative tests: wrong password 5× → locked; expired activation code → generic 400; unknown bootstrap token → 404 (route stays hidden).

## Phase 4 — Data protection & DR

- [ ] Schedule nightly `pg_dump` per database (see `docs/backup-restore.md`).
- [ ] Run `scripts/restore-drill.ps1` once before go-live and note the result in `docs/stage-2-report.md`.
- [ ] Confirm retention job (`RETENTION_DAYS=90`) prunes old attendance events.

## Phase 5 — Observability

- [ ] Ship stdout/stderr to your log platform (e.g. Docker logging driver → Loki/CloudWatch).
- [ ] Alert on: any `level:error`, 5xx rate > 1%, readyz failures.
- [ ] Verify correlation ids flow portal → service in the shipped logs.

## Phase 6 — Final gate

- [ ] `npm run test` — green
- [ ] `npm run typecheck` — green
- [ ] `npm run build` — green
- [ ] CI workflow (`.github/workflows/ci.yml`) green on the release commit
- [ ] All Phase 1 items merged and re-tested in a container build
