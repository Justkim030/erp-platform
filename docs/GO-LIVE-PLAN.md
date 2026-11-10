# Go-Live Plan — ERP Platform v0.2

**Maintainer: JUSTKIM** · Companion to `PRODUCTION-CHECKLIST.md` (the granular tick-box
runbook) and `ROADMAP.md`. This document answers two questions: *how ready is the
system today*, and *what do I do next, in what order*.

---

## 1. Where the system stands (assessed 2026-11-10)

### Verified and solid

| Area | Evidence |
|---|---|
| Behaviour correctness | 39 automated e2e tests green (`npm run test`), incl. real-DB suites |
| Data integrity under load | Perf harness: 800 concurrent clock-ins → 0 errors, 0 duplicates, advisory locks held |
| Auth hardening | Argon2id, refresh-family rotation with reuse detection, lockout, single-use codes |
| Input safety | `ValidationPipe` whitelist+forbid on every route; CSV formula-injection escaping verified |
| Tenancy isolation | Tested cross-tenant 404s on every scoped resource |
| Privacy | Coordinate erasure after `RETENTION_DAYS`, audited map views, no PII in logs |
| Observability | JSON logs, correlation ids end-to-end (portal → service → audit metadata) |
| Scale baseline | 3,000 users seeded via real API; steady-state p95 < 400 ms, 0 errors |

### Known gaps — blockers before real employees' data (ranked)

| # | Gap | Why it blocks | Effort |
|---|---|---|---|
| 1 | **Docker stack never run end-to-end** | Compose is the deployment vehicle; unrun code is unknown code | ½ day |
| 2 | **Browser/device testing never done** | Geolocation prompts, mobile layout, passkeys — all "works in theory" | 1 day |
| 3 | **CI pipeline missing** | The 39 tests only run when someone remembers | ½ day |
| 4 | **No automated backup/restore proven** | `docs/backup-restore.md` exists; the drill hasn't been executed | ½ day |
| 5 | **No HTTPS termination story** | Cookies/CSP/WebAuthn require TLS in production | ½ day |
| 6 | **Single-host compose = single point of failure** | Acceptable for pilot; not for 3,000-user production | later |
| 7 | **Morning-rush login throughput** | Single Identity instance ≈ 100 logins/min CPU-bound; solved by replicas, not caching | 2 h |

### Performance findings (harness in `scripts/perf/`)

- **Database is not the bottleneck.** Hot queries measure 0.1–0.2 ms with correct indexes.
- **Login is CPU-bound** in Argon2id on Node's single thread: p50 ≈ 830 ms at 100-way
  concurrency, but *correct* — the fix is horizontal replicas of Identity (JWKS design
  already allows it; nothing in-memory is authoritative).
- **`/attendance/state` does 4 sequential DB round-trips** — cheapest big win (collapse
  to one query), worth doing before the pilot.
- **Board aggregation happens in JS** per team member — fine ≤ ~50 workers/team;
  convert to a single GROUP BY query before teams grow.

---

## 2. The step-by-step path to production

Do these in order. Each phase ends with something you can verify. The detailed
tick-boxes live in `PRODUCTION-CHECKLIST.md`; here is the sequence and the why.

### Phase A — Make it reproducible (½–1 day)

1. **CI first.** `.github/workflows/ci.yml`: node 22 → `npm ci` → `npm run test` →
   `npm run typecheck` → `npm run build` on every PR. This is the guardrail for
   everything after it.
2. **Run the Docker stack locally** (`docker compose up --build`). Fix whatever
   surfaces — first contact with a Dockerfile often surfaces the `TRUST_PROXY`,
   `COOKIE_SECURE`, and JWKS boot order issues.
3. Commit + push. Branch per item, roadmap ID in the commit message.

### Phase B — Security config for a real host (½ day)

4. Rent/allocate the production host. Install Docker + compose.
5. Fill `.env` from `.env.example`: generated `SIGNING_KEY_JWK`, ≥32-byte
   `PLATFORM_BOOTSTRAP_TOKEN`, strong `POSTGRES_PASSWORD`, `PLATFORM_ALLOWED_IPS`
   = your office/VPN IP, `DEFAULT_ORG`.
6. Put a TLS reverse proxy (Caddy is the least-config option; nginx equally fine) in
   front of the portal. Set `COOKIE_SECURE=true`, `CSP_MODE=enforce` only after
   Phase C. Set `TRUST_PROXY` = number of proxy hops.
7. Set `WEBAUTHN_RP_ID` to the real domain, `WEBAUTHN_ORIGINS` to its HTTPS origin.

### Phase C — Device & browser validation (1 day)

8. Open the portal on real Android/iOS phones. Walk: onboarding → PIN → clock-in
   (geolocation prompt) → map → review → work report → passkey enrolment.
9. Watch the CSP reports (report-only mode) for violations; only then flip `enforce`.
10. Test declined-clock-in flow, review flow, and exception request on mobile.

### Phase D — Data protection drill (½ day)

11. Nightly `pg_dump` cron for both databases (script exists in `docs/backup-restore.md`).
12. **Execute the restore drill** (`scripts/restore-drill.ps1`) and record the result
    in `docs/stage-2-report.md`. An untested backup is not a backup.

### Phase E — Controlled pilot (1 week of calendar)

13. Create the real organisation via the platform endpoint (never `DEV_SEED_ORG`).
14. Onboard 5–20 pilot employees. Capture real-device friction.
15. Watch logs (`level:error`, readyz, correlation ids). Fix friction items.
16. Only after a clean pilot week: onboard the wider organisation.

### Phase F — Beyond single-host (when it matters)

17. Second Identity replica (login throughput scales linearly). Move throttler
    buckets to Redis when you do.
18. Managed Postgres (RDS/Neon/similar) with automated backups replaces the
    single-host volume.
19. OpenTelemetry spans alongside the correlation ids (roadmap L-2).

---

## 3. Definition of "production-ready"

You may put real employee data on the system when **all** of these are true:

- [ ] CI green on the release commit (tests + typecheck + build)
- [ ] Full compose stack runs from scratch on the production host
- [ ] HTTPS + correct `TRUST_PROXY` verified; cookies Secure; CSP enforcing
- [ ] WebAuthn RP ID/origins set to the real domain
- [ ] Restore drill executed and timed
- [ ] Mobile/browser walk-through passed on real devices
- [ ] Pilot cohort active for a week with no data-integrity incidents
- [ ] Backup cron observed running for ≥ 3 nights

Until then: the system is **functionally production-grade** (this audit found no
correctness gaps) but **operationally unproven** — the gaps above are operational,
which is exactly what Phases A–D close.
