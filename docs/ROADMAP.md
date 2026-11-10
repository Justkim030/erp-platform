# Improvement Roadmap — ERP Platform v0.2

**Developer & maintainer: JUSTKIM** · Prioritised backlog derived from the production audit. Items marked 🔴 block go-live; 🟡 should land within the first month; 🟢 later. Your working procedure lives in `docs/DEVELOPER-GUIDE.md`; the go-live runbook is `docs/PRODUCTION-CHECKLIST.md`.

## 🔴 Blockers (before production)

| ID  | Item                                                                                    | Where                                                      | Effort |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------ |
| B-1 | ✅ Done: use only the trusted Next.js request IP; never forward a browser-supplied forwarding header | `apps/portal-web/app/api/svc/[service]/[...path]/route.ts` | — |
| B-2 | ✅ Done: global exception filter returns JSON with a correlation id and logs 5xx failures | both services' `setup.ts` | — |
| B-3 | ✅ Done: private repo **Justkim030/erp-platform**, baseline pushed, `git ls-files` audit clean, repo-local identity pinned to Justkim030 | repo root | — |
| B-4 | ✅ Done: Identity rejects a missing or under-32-byte `PLATFORM_BOOTSTRAP_TOKEN` in production | `services/identity/src/config.ts` | — |
| B-5 | ✅ Done: liveness/readiness endpoints and Compose healthchecks; readiness checks DB and Identity JWKS | services + `docker-compose.yml` | — |

## 🟡 Next 30 days

| ID  | Item                                               | Notes                                                                    |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| N-1 | ✅ Done | Throttling at three layers: Identity auth routes (10/min), Attendance clock routes (20/min), and the portal's own auth routes (in-memory token bucket, `apps/portal-web/lib/rate-limit.ts`). Revisit all three for Redis when scaling horizontally |
| N-2 | Remove dev-memory demo path from production builds | ✅ Done: seeding is opt-in via `DEV_SEED_ORG=1`, the demo password was deleted, `DEFAULT_ORG` has no fallback |
| N-3 | Integration test for the BFF proxy                 | spin up a stub upstream, assert allow-list, refresh, and header handling |
| N-4 | Per-service e2e smoke test in CI                   | run `docker compose up`, hit `/readyz` and one happy-path flow           |
| N-5 | ✅ Done: refresh-token family hashes are rotated and revoked on reuse |
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
