#!/usr/bin/env node
// Load test for the ERP platform services.
// Scenarios model the real usage of a 3000+-person mobile web app:
//   warmup   - single sequential requests to establish baselines
//   morning  - 1500 workers clock in within a 10-minute window (accelerated)
//   mixed    - steady-state mixed reads/writes (board, history, sites, state)
//   supper   - supervisors polling the team board concurrently
//
// Usage: node scripts/perf/load-test.mjs [--users N] [--scenario name]
const BASE_I = process.env.IDENTITY_URL ?? 'http://127.0.0.1:3001';
const BASE_A = process.env.ATTENDANCE_URL ?? 'http://127.0.0.1:3002';
const PASS = 'Perf-Test-Passphrase-2026!';
const PIN = '482915';
const WORKER_START = 200000;
const N_WORKERS = 3000;
const N_SUPERS = 120;
const CENTER = { lat: -0.5388, lng: 37.4596, accuracy: 15 };

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const SCENARIO = flag('--scenario', 'all');

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const stats = {};
function record(name, ms, ok) {
  (stats[name] ??= { n: 0, ok: 0, err: 0, total: 0, max: 0, samples: [] });
  const s = stats[name];
  s.n++; s.total += ms; s.max = Math.max(s.max, ms);
  ok ? s.ok++ : s.err++;
  if (s.samples.length < 5000) s.samples.push(ms);
}
function report() {
  console.log('\n=== RESULTS ===');
  console.log('scenario                n      ok    err    avg(ms)  p50    p95    p99    max');
  for (const [name, s] of Object.entries(stats)) {
    console.log(
      name.padEnd(22),
      String(s.n).padStart(6),
      String(s.ok).padStart(6),
      String(s.err).padStart(4),
      Math.round(s.total / s.n).toString().padStart(8),
      Math.round(percentile(s.samples, 50)).toString().padStart(6),
      Math.round(percentile(s.samples, 95)).toString().padStart(6),
      Math.round(percentile(s.samples, 99)).toString().padStart(6),
      Math.round(s.max).toString().padStart(6),
    );
  }
}

async function timed(name, fn) {
  const t0 = performance.now();
  let ok = false;
  try { ok = (await fn()) !== false; } catch { ok = false; }
  record(name, performance.now() - t0, ok);
}

// --- client helpers ---------------------------------------------------------
// NOTE: every HTTP call in scenarios below is wrapped in timed() so the report
// reflects real request latency, not just scenario wall-clock.
async function login(org, staffNumber, secret) {
  const r = await fetch(`${BASE_I}/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organisation: org, staffNumber, password: secret }),
  });
  if (!r.ok) return null;
  return r.json();
}
async function authed(base, path, token, init = {}) {
  const r = await fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.body ? {} : {}) } });
  return r;
}

// --- scenario drivers -------------------------------------------------------
async function warmup() {
  const t = (await login('perf', '0001', PASS))?.accessToken;
  await timed('warm-login', () => login('perf', '200000', PIN));
  const state = await authed(BASE_A, '/v1/attendance/state', t);
  await timed('warm-state', async () => (await authed(BASE_A, '/v1/attendance/state', t)).ok ? true : false);
  await timed('warm-board', async () => (await authed(BASE_A, '/v1/team/attendance', t)).ok ? true : false);
  await timed('warm-map', async () => (await authed(BASE_A, '/v1/team/map', t)).ok ? true : false);
  await timed('warm-history', async () => (await authed(BASE_A, '/v1/attendance/history?days=31', t)).ok ? true : false);
  console.log('warmup done, state:', state.status);
}

// morning rush: many workers logging in + clocking in nearly simultaneously
async function morning(users = 800, concurrency = 100) {
  let idx = 0; let errors = 0;
  const queue = Array.from({ length: users }, (_, i) => i);
  const t0 = performance.now();
  async function run() {
    while (queue.length) {
      queue.shift();
      const sn = String(WORKER_START + (idx++ % N_WORKERS));
      try {
        await timed('rush-login', async () => {
          const l = await login('perf', sn, PIN);
          if (!l) throw new Error('login failed');
          return true;
        });
        const l = await login('perf', sn, PIN);
        if (!l) { errors++; continue; }
        await timed('rush-clock-in', async () => {
          const r = await fetch(`${BASE_A}/v1/attendance/clock-in`, {
            method: 'POST',
            headers: { authorization: `Bearer ${l.accessToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ reading: { ...CENTER, capturedAt: new Date().toISOString() } }),
          });
          if (!r.ok && r.status !== 409) throw new Error(`clock-in ${r.status}`);
          return true;
        });
      } catch { errors++; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  const secs = (performance.now() - t0) / 1000;
  console.log(`morning: ${users} workers in ${secs.toFixed(1)}s (${(users / secs).toFixed(0)} workers/s), errors=${errors}`);
}

// steady-state mixed traffic like a normal workday
async function mixed(seconds = 30, virtualUsers = 60) {
  const deadline = performance.now() + seconds * 1000;
  async function vu(id) {
    // each VU = one supervisor doing periodic reads (board, history) + occasional clock events
    const sn = String(1000 + (id % N_SUPERS));
    const l = await login('perf', sn, PASS);
    if (!l) return;
    while (performance.now() < deadline) {
      await timed('mixed-board', async () => (await authed(BASE_A, '/v1/team/attendance', l.accessToken)).ok ? true : false);
      await timed('mixed-history', async () => (await authed(BASE_A, '/v1/attendance/history?days=31', l.accessToken)).ok ? true : false);
      await timed('mixed-state', async () => (await authed(BASE_A, '/v1/attendance/state', l.accessToken)).ok ? true : false);
      if (id % 5 === 0) await timed('mixed-map', async () => (await authed(BASE_A, '/v1/team/map', l.accessToken)).ok ? true : false);
    }
  }
  // plus workers polling state + clocking in/out
  async function wvu(id) {
    const sn = String(WORKER_START + (id * 7 % N_WORKERS));
    const l = await login('perf', sn, PIN);
    if (!l) return;
    while (performance.now() < deadline) {
      await timed('mixed-worker-state', async () => (await authed(BASE_A, '/v1/attendance/state', l.accessToken)).ok ? true : false);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await Promise.all([
    ...Array.from({ length: Math.floor(virtualUsers / 2) }, (_, i) => vu(i)),
    ...Array.from({ length: virtualUsers }, (_, i) => wvu(i)),
  ]);
}

async function supper(users = 200, concurrency = 40) {
  const queue = Array.from({ length: users }, (_, i) => i);
  async function run() {
    while (queue.length) {
      const i = queue.shift();
      const sn = String(1000 + (i % N_SUPERS));
      const l = await login('perf', sn, PASS);
      if (!l) continue;
      await timed('supper-board', async () => (await authed(BASE_A, '/v1/team/attendance', l.accessToken)).ok ? true : false);
      await timed('supper-map', async () => (await authed(BASE_A, '/v1/team/map', l.accessToken)).ok ? true : false);
      await timed('supper-reviews', async () => (await authed(BASE_A, '/v1/team/reviews', l.accessToken)).ok ? true : false);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
}

const table = { warmup, morning, mixed, supper };
const scenarios = SCENARIO === 'all' ? Object.keys(table) : [SCENARIO];
for (const s of scenarios) {
  console.log(`\n--- scenario: ${s} ---`);
  if (s === 'morning') await morning(Number(flag('--users', 800)), Number(flag('--concurrency', 100)));
  else if (s === 'mixed') await mixed(Number(flag('--seconds', 30)), Number(flag('--vus', 60)));
  else if (s === 'supper') await supper(Number(flag('--users', 200)), Number(flag('--concurrency', 40)));
  else await table[s]();
}
report();
