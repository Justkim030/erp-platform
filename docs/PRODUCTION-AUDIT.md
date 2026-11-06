# Production Readiness Audit — ERP Platform v0.2

> Audit date: 2026-11-06 · Scope: `services/*`, `apps/portal-web`, infra, CI, docs
> Verification run: `npm run test` (53 passed / 17 skipped), `npm run typecheck` — **all green**.

## 1. Verdict

**Conditionally ready for production.** The codebase is unusually well-hardened for its size (no hardcoded secrets, argon2id, CSRF defence, BFF pattern, production-config validation). The blockers below must be closed before go-live; the rest is hardening advice.

## 2. Secrets audit — PASS (with cleanups needed)

| Check                                                                      | Result                             |
| -------------------------------------------------------------------------- | ---------------------------------- |
| Hardcoded passwords/keys in `services/*/src`                               | ✅ None found                      |
| `.env` present in repo / committed                                         | ✅ No `.env` file exists           |
| `.gitignore` covers `.env`, `*.log`, `node_modules`, `dist`, `.next`       | ✅ Yes                             |
| Docker Compose injects secrets via env, errors when missing (`${VAR:?}`)   | ✅ Good pattern                    |
| Demo password `ChangeMe-Now-2026` in `services/identity/src/dev-memory.ts` | ✅ Removed — seeding is now opt-in via `DEV_SEED_ORG=1` and no password is ever seeded |
| Test fixtures contain plaintext passwords (`SupA-2026-pass` etc.)          | ✅ Acceptable (test data only)     |

⚠️ **The folder is NOT a git repository** (`.git` missing). Until you run `git init`, nothing is version-controlled and `backups/*.dump` (real database dumps) sit untracked-but-unprotected on disk — see task 4.2.

## 3. Bugs / issues found & fixed during this audit

| #   | Finding                                                                                                                                                                                                                                                                                                                                   | Severity                                    | Status                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------- |
| 3.1 | Leftover debug `console.log('DEBUG-CREATEUSER …')` in `services/identity/src/admin.service.ts:61` leaking internal IDs to stdout in production                                                                                                                                                                                            | Low                                         | ✅ Fixed (line removed)                         |
| 3.2 | Leftover debug `console.log` in `services/identity/test/org-structure.spec.ts:102`                                                                                                                                                                                                                                                        | Low                                         | ✅ Fixed                                        |
| 3.3 | Stray log files & QA artifacts in repo root (`svc-*.log`, `npm-ci.log`, `pw-install*.log`, `qa-standalone.log`, `qa-standalone/`, `.pgtest/` with a live PostgreSQL data directory, `backups/*.dump`)                                                                                                                                     | Medium                                      | 🔲 Clean up (task 4.2)                          |
| 3.4 | No global exception filter: an unhandled service exception returns Nest's default HTML/500, which leaks stack info in some configs and doesn't emit the JSON error envelope or correlation id                                                                                                                                             | Medium                                      | 🔲 Add `HttpExceptionFilter` (task 5.1)         |
| 3.5 | `PLATFORM_BOOTSTRAP_TOKEN` has no minimum-length check at startup                                                                                                                                                                                                                                                                         | Low                                         | 🔲 Add to `validateProductionConfig` (task 5.2) |
| 3.6 | Portal BFF proxy forwards raw `x-forwarded-for` from the browser to services — a client can spoof its IP for the staff-network check                                                                                                                                                                                                      | High (if direct portal exposure is trusted) | 🔲 Overwrite the header server-side (task 5.3)  |
| 3.7 | Route allow-list regex `^identity/v1/users(\/[\w-]+\/reset-access)?$` blocks the paginated `?page=` variant is fine, but **`PUT`/`DELETE`** methods are not exported (`export { handle as GET, handle as POST, handle as PUT }` only) — a `PATCH`/`DELETE` to a whitelisted path returns a Next.js 405, which is correct but undocumented | Info                                        | Document in API docs                            |

## 4. Repository hygiene (do first)

### 4.1 Initialise version control

```
git init
git add -A
git commit -m "baseline v0.2"
```

Add a remote and push before any further changes. All future work should be on branches.

### 4.2 Move runtime artifacts out of the repo root

Create `artifacts/` (gitignored) and move: `*.log`, `qa-standalone*/`, `pw-install*.log`, `npm-ci.log`.
`.pgtest/` (a real PostgreSQL data dir) and `backups/*.dump` must be moved to a machine location **outside the project** and added to `.gitignore` — they contain live employee data.

## 5. Code fixes (ordered)

1. **5.1 Global exception filter** — create `services/<svc>/src/http-exception.filter.ts` that catches all exceptions, logs them with the correlation id, and returns `{ statusCode, message, correlationId }` JSON. Register with `app.useGlobalFilters(...)` in both `setup.ts` files.
2. **5.2 Bootstrap token strength** — in `validateProductionConfig`, require `PLATFORM_BOOTSTRAP_TOKEN` to be set and ≥ 32 characters in production.
3. **5.3 BFF header sanitisation** — in `apps/portal-web/app/api/svc/[service]/[...path]/route.ts`, replace the forwarded `x-forwarded-for` with the connection IP known to the portal, or append to it (`xff + ', ' + trustedClientIp`), so the attendance service's staff-network check cannot be spoofed.
4. **5.4 Rate limiting** — login/activate/reset endpoints rely on the identity service's lockout counter, but there is no IP-level rate limit on the portal's `/api/auth/*` routes. Add a small in-memory token bucket (or `@upstash/ratelimit` when serverless).
5. **5.5 Health endpoints** — add `/healthz` (liveness) and `/readyz` (checks DB + JWKS) to both services and reference them in `docker-compose.yml` `healthcheck:` so compose restarts a wedged service.
6. **5.6 Log level configuration** — `JsonLogger.debug` already gates on `LOG_LEVEL=debug`; also gate Nest's built-in levels in `NestFactory.create(AppModule, { logger, loggerLevels })` per env.

## 6. Architecture review — strong points

- **Modular monolith → microservice split** is clean: `identity` (auth/users/org) and `attendance` (sites/verification) share identity via JWKS, no shared DB.
- **BFF pattern** in the portal: tokens never reach browser JS; the browser only sees whitelisted `/api/svc/...` routes.
- **Layering** inside services is consistent: `controllers → services → db`, DTOs validated with `class-validator` + `whitelist/forbidNonWhitelisted`, pure functions extracted (`verification.ts`, `security.ts`) and unit-tested.
- **Transactions + audit rows in the same tx** (`db.tx`, `audit.recordWithinTx`) — correct.
- **Migration runner** with `schema_migrations` ledger — correct.
- **Correlation-id middleware** across all hops — good observability base.

Gaps: no per-repository data layer (SQL is inline in services — acceptable at this size, but adopt a `repositories/` folder as the data layer grows), no integration-test for the BFF proxy itself.

## 7. Verification checklist before go-live

- [ ] `npm run test` and `npm run typecheck` pass (✅ verified 2026-11-06)
- [ ] `docker compose up` with a fresh `.env` (run `npm run gen-key -w @platform/identity` first)
- [ ] `COOKIE_SECURE=true`, `CSP_MODE=enforce` behind HTTPS
- [ ] `PLATFORM_ALLOWED_IPS` set to the operator's IP
- [ ] Restore drill executed: `scripts/restore-drill.ps1` (see `docs/backup-restore.md`)
- [ ] Log shipping verified (JSON lines parse correctly)

## 8. Referenced documents

- `docs/PRODUCTION-CHECKLIST.md` — step-by-step go-live runbook
- `docs/ROADMAP.md` — prioritised improvement backlog
