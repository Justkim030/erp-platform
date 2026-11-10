#!/usr/bin/env node
// Perf bootstrap: logs in as the seeded admin and creates one attendance site
// so clock-ins have a target. Run after seed.mjs.
const BASE_A = process.env.ATTENDANCE_URL ?? 'http://127.0.0.1:3002';
const BASE_I = process.env.IDENTITY_URL ?? 'http://127.0.0.1:3001';
const PASS = 'Perf-Test-Passphrase-2026!';
const l = await (await fetch(`${BASE_I}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organisation: 'perf', staffNumber: '0001', password: PASS }) })).json();
const r = await fetch(`${BASE_A}/v1/sites`, {
  method: 'POST',
  headers: { authorization: `Bearer ${l.accessToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Perf HQ', lat: -0.5388, lng: 37.4596, radiusM: 300 }),
});
console.log(r.status, await r.text());
