// Platform-owner script: creates an organisation and prints the administrator's one-time activation code.
// The administrator then sets their own password on first sign-in. Needs PLATFORM_BOOTSTRAP_TOKEN.
const base = process.env.IDENTITY_URL ?? 'http://localhost:3001';
const required = ['ORG_NAME', 'ORG_SLUG', 'ADMIN_STAFF_NUMBER', 'ADMIN_NAME'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) { console.error(`Missing environment variables: ${missing.join(', ')}. See .env.example.`); process.exit(1); }
const res = await fetch(`${base}/v1/platform/organisations`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-bootstrap-token': process.env.PLATFORM_BOOTSTRAP_TOKEN ?? '' },
  body: JSON.stringify({
  name: process.env.ORG_NAME, slug: process.env.ORG_SLUG,
  adminStaffNumber: process.env.ADMIN_STAFF_NUMBER, adminName: process.env.ADMIN_NAME,
  }),
});
console.log(res.status, await res.text());
