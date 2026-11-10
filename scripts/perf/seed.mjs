#!/usr/bin/env node
// Perf seed: one org, an admin + 120 supervisors + 3000 workers, all activated.
// Prints one line per created cohort so progress is visible.
const BASE = process.env.IDENTITY_URL ?? 'http://127.0.0.1:3001';
const BOOT = 'perf-bootstrap-token-0123456789abcdef';
const PASS = 'Perf-Test-Passphrase-2026!';
const PIN = '482915';
const N_SUPERVISORS = 120;
const N_WORKERS = 3000;

const org = await fetch(`${BASE}/v1/platform/organisations`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bootstrap-token': BOOT },
  body: JSON.stringify({ name: 'Perf Organisation', slug: 'perf', adminStaffNumber: '0001', adminName: 'Perf Admin' }),
});
const orgBody = await org.json();
console.log('org:', org.status);

const act = await fetch(`${BASE}/v1/auth/activate`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ organisation: 'perf', staffNumber: '0001', activationCode: orgBody.activationCode, credentialType: 'password', secret: PASS }),
});
const actBody = await act.json();
if (!act.ok) { console.error('admin activate failed', actBody); process.exit(1); }
const adminToken = actBody.accessToken;
console.log('admin activated');

// Bulk-create via the platform endpoint (no auth churn), each with a random supervisor.
async function addUser(staffNumber, role, supervisorStaffNumber) {
  const res = await fetch(`${BASE}/v1/platform/organisations/perf/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bootstrap-token': BOOT },
    body: JSON.stringify({ staffNumber, fullName: `User ${staffNumber}`, role, supervisorStaffNumber }),
  });
  if (!res.ok) throw new Error(`addUser ${staffNumber} -> ${res.status}`);
  return (await res.json()).activationCode;
}
async function activate(staffNumber, code, type, secret) {
  const res = await fetch(`${BASE}/v1/auth/activate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organisation: 'perf', staffNumber, activationCode: code, credentialType: type, secret }),
  });
  if (!res.ok) throw new Error(`activate ${staffNumber} -> ${res.status}`);
}

const supNumbers = [];
for (let i = 0; i < N_SUPERVISORS; i++) {
  const sn = String(1000 + i);
  supNumbers.push(sn);
  const code = await addUser(sn, 'supervisor');
  await activate(sn, code, 'password', PASS);
}
console.log(`supervisors: ${N_SUPERVISORS}`);

const concurrency = 20;
let done = 0, failed = 0;
const queue = [];
for (let i = 0; i < N_WORKERS; i++) queue.push(i);
async function worker() {
  while (queue.length) {
    const i = queue.shift();
    const sn = String(200000 + i);
    try {
      const code = await addUser(sn, 'worker', supNumbers[i % N_SUPERVISORS]);
      await activate(sn, code, 'pin', PIN);
    } catch (e) { failed++; if (failed < 5) console.error(e.message); }
    done++;
    if (done % 500 === 0) console.log(`workers: ${done}/${N_WORKERS}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`DONE workers=${done} failed=${failed}`);
