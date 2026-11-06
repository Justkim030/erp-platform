// Platform-owner script: adds a real user (any role) to an organisation. Usage:
//   PLATFORM_BOOTSTRAP_TOKEN=... node scripts/platform-add-user.mjs <org-slug> <staffNumber> "<Full Name>" <role> [supervisorStaffNumber]
const [slug, staffNumber, fullName, role, supervisorStaffNumber] = process.argv.slice(2);
if (!slug || !staffNumber || !fullName || !role) { console.error('Usage: platform-add-user.mjs <org-slug> <staffNumber> "<Full Name>" <role> [supervisorStaffNumber]'); process.exit(1); }
const base = process.env.IDENTITY_URL ?? 'http://localhost:3001';
const res = await fetch(`${base}/v1/platform/organisations/${slug}/users`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bootstrap-token': process.env.PLATFORM_BOOTSTRAP_TOKEN ?? '' },
  body: JSON.stringify({ staffNumber, fullName, role, ...(supervisorStaffNumber ? { supervisorStaffNumber } : {}) }),
});
console.log(res.status, await res.text());
