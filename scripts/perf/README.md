# Performance test harness

Reusable load-test tooling for the ERP platform. It runs against **real PostgreSQL**
(an isolated throwaway instance on port 5544 — see `scripts/test-db-init.ps1`) and the
compiled production builds of both services. Everything here is safe to commit; the
throwaway database lives in `.pgtest/` and is git-ignored.

## One-time setup

```powershell
# 1. Isolated PostgreSQL on :5544 (disposable, no Docker needed)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-db-init.ps1

# 2. Compiled builds
npm run build

# 3. Start both services against the test databases (each script waits for the DB)
Start-Process cmd -ArgumentList '/c scripts\perf\run-identity.cmd' -WindowStyle Hidden
Start-Process cmd -ArgumentList '/c scripts\perf\run-attendance.cmd' -WindowStyle Hidden

# 4. Seed: org + admin + 120 supervisors + 3000 activated workers (via the real API)
node scripts\perf\seed.mjs

# 5. Create one site so clock-ins have a target
node scripts\perf\bootstrap.mjs
```

## Scenarios

```powershell
node scripts\perf\load-test.mjs --scenario warmup    # single-user baselines
node scripts\perf\load-test.mjs --scenario morning --users 800 --concurrency 100
node scripts\perf\load-test.mjs --scenario mixed   --seconds 30 --vus 80
node scripts\perf\load-test.mjs --scenario supper  --users 200 --concurrency 40
node scripts\perf\load-test.mjs --scenario all
```

Outputs a percentile table (avg / p50 / p95 / p99 / max, error count) per request type.

## What the scenarios model

| Scenario | Models | Notes |
|---|---|---|
| `warmup` | first user of the day | establishes single-request baselines |
| `morning` | the login + clock-in rush | the dominant peak: everyone arrives and clocks in within minutes |
| `mixed` | steady-state workday | supervisors polling board/history, workers polling state |
| `supper` | end-of-day supervisor review burst | board + map + review queue under concurrency |

## Findings from the 2026-11-10 run (3,000 users seeded)

See the perf report in `docs/GO-LIVE-PLAN.md`. Headline: DB is not the bottleneck
(sub-millisecond hot queries); login throughput is CPU-bound in Argon2id and scales
by running more Identity instances, not by caching.
