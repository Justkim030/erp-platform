# Improvement Roadmap — ERP Platform v0.2

**Developer & maintainer: JUSTKIM** · Prioritised backlog derived from the production audit. Items marked 🔴 block go-live; 🟡 should land within the first month; 🟢 later. Your working procedure lives in `docs/DEVELOPER-GUIDE.md`; the go-live runbook is `docs/PRODUCTION-CHECKLIST.md`.

## 🔴 Blockers (before production)

| ID  | Item                                                                                    | Where                                                      | Effort |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------ |
| B-1 | Sanitise `x-forwarded-for` in the BFF proxy so the staff-network check can't be spoofed | `apps/portal-web/app/api/svc/[service]/[...path]/route.ts` | 1 h    |
| B-2 | Global exception filter returning JSON + correlation id on every error                  | both services' `setup.ts`                                  | 2 h    |
| B-3 | Repo hygiene: `git init`, move `.pgtest/`, `backups/`, logs out of the repo             | repo root                                                  | 1 h    |
| B-4 | Require strong `PLATFORM_BOOTSTRAP_TOKEN` in `validateProductionConfig`                 | both `config.ts`                                           | 30 min |
| B-5 | Health endpoints (`/healthz`, `/readyz`) + compose healthchecks                         | services + `docker-compose.yml`                            | 2 h    |

## 🟡 Next 30 days

| ID  | Item                                               | Notes                                                                    |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| N-1 | Rate limiting on portal auth routes                | in-memory token bucket; revisit when scaling horizontally (needs Redis)  |
| N-2 | Remove dev-memory demo path from production builds | ✅ Done: seeding is opt-in via `DEV_SEED_ORG=1`, the demo password was deleted, `DEFAULT_ORG` has no fallback |
| N-3 | Integration test for the BFF proxy                 | spin up a stub upstream, assert allow-list, refresh, and header handling |
| N-4 | Per-service e2e smoke test in CI                   | run `docker compose up`, hit `/readyz` and one happy-path flow           |
| N-5 | Refresh-token rotation detection                   | store token family hashes; revoke family on reuse                        |
| N-6 | Audit-log retention & export job                   | mirror the attendance retention pattern for `audit_log`                  |

## 🟢 Later

| ID  | Item                                                             | Notes                                         |
| --- | ---------------------------------------------------------------- | --------------------------------------------- |
| L-1 | Extract a repository layer per service as SQL grows              | keep `db.tx` as the unit-of-work              |
| L-2 | OpenTelemetry traces alongside the JSON logs                     | correlation ids already exist; add span ids   |
| L-3 | Admin UI for supervisors instead of API-only flows               | reuse the portal's component library          |
| L-4 | Multi-region / managed Postgres evaluation                       | revisit when moving off single-host compose   |
| L-5 | Automated dependency updates (Renovate) + `npm audit` gate in CI | add `npm audit --production` step to `ci.yml` |

## Definition of done for any roadmap item

1. Branch created from `main`; PR description links the item ID.
2. Tests added/updated; `npm run test` and `npm run typecheck` green.
3. Relevant doc updated (`docs/*.md`) and this roadmap row marked done.
