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

### 1.1 Global exception filter (both services)

- [ ] Create `services/identity/src/http-exception.filter.ts` and the same file for attendance:

```ts
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const status =
      e instanceof HttpException
        ? e.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const message =
      e instanceof HttpException ? e.message : "Internal server error.";
    // TODO: read correlation id from the request and include it here + log it
    res.status(status).json({ statusCode: status, message });
  }
}
```

- [ ] Register in both `setup.ts`: `app.useGlobalFilters(new AllExceptionsFilter());`
- [ ] `npm run test -w @platform/identity && npm run test -w @platform/attendance` still pass.

### 1.2 Strengthen production config validation

- [ ] In both `src/config.ts`, extend `validateProductionConfig`:
  - `PLATFORM_BOOTSTRAP_TOKEN` must be set and ≥ 32 chars.
  - `COOKIE_SECURE` note: portal only — check `.env` of the portal, not the service.
- [ ] Add a unit test asserting startup is blocked when the token is short.

### 1.3 Sanitise the BFF's forwarded IP (HIGH priority)

- [ ] In `apps/portal-web/app/api/svc/[service]/[...path]/route.ts` line ~33: do not pass the browser-supplied `x-forwarded-for` through unchanged. Either drop it, or set it to the portal's own knowledge of the client address. Otherwise a worker can spoof the staff-network check for clock-in.
- [ ] Confirm the attendance service trusts exactly 1 proxy (`TRUST_PROXY=1`) so it reads the _last_ hop, not the first.

### 1.4 Rate-limit portal auth routes

- [ ] Add a small token-bucket helper `apps/portal-web/lib/rate-limit.ts` keyed on IP for `/api/auth/login`, `/activate`, and the svc proxy.
- [ ] Return 429 with the same friendly message the frontend already handles.

### 1.5 Health endpoints + compose healthchecks

- [ ] Add `GET /healthz` (always 200) and `GET /readyz` (checks DB query + JWKS availability) to identity and attendance.
- [ ] Add `healthcheck:` blocks to the `identity`, `attendance`, and `portal` services in `docker-compose.yml` mirroring the postgres one.
- [ ] Change attendance's `depends_on` for identity to `condition: service_healthy`.

## Phase 2 — Environment configuration

- [ ] `Copy-Item .env.example .env`
- [ ] `npm run gen-key -w @platform/identity` → paste JSON into `SIGNING_KEY_JWK` (one line).
- [ ] Set `PLATFORM_BOOTSTRAP_TOKEN` to a ≥ 32-char random string (`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`).
- [ ] Generate a strong `POSTGRES_PASSWORD` (not `platform`).
- [ ] `PLATFORM_ALLOWED_IPS` = the operator's office/VPN IP.
- [ ] `COOKIE_SECURE=true` and `CSP_MODE=enforce` once the site is behind HTTPS.
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
