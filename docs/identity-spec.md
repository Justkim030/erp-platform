# Identity Service specification (v0.1)

## Responsibilities
Organisations (tenants), users, invitations, activation, login, sessions, password reset, roles, audit trail, public signing key.
Out of scope for v0.1: passkeys, email/SMS delivery (development notifier only), event publishing, single sign-on with external providers.

## Endpoints
| Method and path | Who | Purpose |
|---|---|---|
| `POST /v1/users` | supervisor, management, admin | Add an employee (supervisor: workers in their own team). Returns a one-time activation code |
| `GET /v1/users` | same | Supervisor: own team. Management and admin: the organisation |
| `POST /v1/users/:id/reset-access` | same, within scope | Clear the credential and issue a new activation code (lost PIN or password) |
| `POST /v1/auth/activate` | Invited employee | `{organisation, staffNumber, activationCode, credentialType: pin or password, secret}`. First-time setup; returns a session |
| `POST /v1/auth/login` | Anyone | `{organisation, staffNumber, password}` where `password` is a password or a PIN |
| `POST /v1/auth/refresh`, `/logout` | Holder of refresh token | Rotate or end a session |
| `POST /v1/auth/password/forgot`, `/reset` | Accounts with a contact on record | Token-based reset (development notifier until the Notifications service exists) |
| `GET /v1/me` | Signed-in user | Current user and organisation |
| `GET /.well-known/jwks.json`, `GET /health` | Public | Public signing key; liveness |
| `POST /v1/platform/organisations` | Platform owner (hidden) | Create an organisation and its administrator; returns the administrator's activation code |
| `POST /v1/platform/organisations/:slug/users` | Platform owner (hidden) | Add any user, any role, to an organisation |

The platform endpoints answer `404` unless `x-bootstrap-token` matches (and, when set, the caller's IP is in `PLATFORM_ALLOWED_IPS`). They are not used by any UI.

## Data model
`tenants`, `users` (unique per tenant by staff number; `supervisor_id` links workers to their supervisor; `credential_type` is `pin` or `password`), `invites` (activation codes) (code stored only as a hash), `refresh_tokens` (hashed, grouped in families), `password_resets` (hashed), `audit_events` (append-only), `schema_migrations`.

## Key flows
- **First sign-in:** a supervisor adds an employee; the system issues a one-time code (10 characters, no look-alike letters, valid 7 days, single use, closed after 5 wrong attempts), shown once. The employee enters staff number, code and a new PIN (workers) or password, which is hashed immediately. After that, the employee just logs in.
- **Login:** unknown account and wrong password return the same error; time is equalised with a dummy hash. Five failures lock the account for 15 minutes (configurable).
- **Refresh rotation:** each refresh token can be used once. Presenting a used token again revokes the whole family and is logged as `token.reuse_detected`.
- **Reset:** single-use token valid 30 minutes; success revokes every session.

## Security decisions
- Passwords: Argon2id (19 MiB, 2 iterations), minimum 10 characters, common passwords refused.
- Access tokens: Ed25519 (EdDSA) JWT, 10 minutes, claims `sub`, `tid`, `role`, `jti`. Refresh tokens: 256-bit random, 14 days, stored hashed.
- Rate limits: per-IP on all routes, stricter on authentication routes. Behind a proxy set `TRUST_PROXY` correctly or limits and audit IPs will be wrong.
- Organisation creation requires a bootstrap token known only to the platform owner; with no token configured it is disabled.
- Management cannot create admin or management accounts; only admin can.
- Audit events for: organisation created, invite created, activation, login success/failure/lock/block, refresh reuse, logout, password reset.

## Known limitations
- Access tokens are not revocable before expiry (10 minutes). Role or status changes take effect at the next refresh.
- Rate-limit counters are in process memory; use Redis storage before running several instances.
- Audit events are written best-effort and do not block a request if the write fails.
