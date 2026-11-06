# Security architecture

## Trust boundaries
Browser -> **Portal** (backend-for-frontend) -> **Identity / Attendance**. The browser never holds tokens or service addresses. Only the Portal needs to be public; Identity and Attendance listen on localhost in Compose and should sit on a private network in production.

## Controls in place
| Area | Control |
|---|---|
| Credentials | Argon2id (19 MiB, 2 passes). Password 10+ characters; PIN 6 to 8 digits, workers only, weak patterns refused. Only hashes stored |
| First-time access | One-time activation code, stored hashed, 7 days, closed after 5 wrong attempts, shown once to the person issuing it. Prevents claiming an account by guessing a staff number |
| Login | Same error for unknown account and wrong secret, equalised timing, lockout (5 failures, 15 minutes), per-IP rate limits |
| Sessions | Ed25519 access tokens (10 minutes), rotating 256-bit refresh tokens (hashed, 14 days), reuse detection revokes the whole session family, reset and logout revoke sessions |
| Service-to-service | Services verify tokens locally with the public key (issuer, audience and algorithm checked). Tenant comes from the token, never the request body |
| Authorisation | Role checks on every endpoint; supervisors limited to their own team; management cannot create admin or management accounts; every record is tenant-scoped |
| Hidden platform endpoints | Answer 404 unless the bootstrap token (constant-time compare) and the optional IP allow-list match; administrators set their own passwords |
| Browser | httpOnly SameSite cookies, `Secure` in production; Origin check on every state-changing request (CSRF); allow-listed proxy routes; nonce-based CSP (report-only until verified); frame, MIME and referrer protections; map popups built from text nodes (no HTML injection) |
| Integrity | Append-only attendance events; reviews recorded with reviewer and time; audit trail for sign-ins, user changes, map views and reviews |
| Privacy | Location read only at clock-in/out; coordinates erased after retention period; map views audited; no biometrics |
| Input | Strict validation (unknown fields rejected), parameterised SQL, request size limits by framework defaults |

## Operating checklist before real data
1. Generate `SIGNING_KEY_JWK`; set a long `PLATFORM_BOOTSTRAP_TOKEN`; set `PLATFORM_ALLOWED_IPS`.
2. Serve the Portal over HTTPS; set `COOKIE_SECURE=true`; put Identity and Attendance on a private network.
3. Set `TRUST_PROXY` to the true number of proxies; confirm client IPs appear correctly in the audit trail.
4. Run on real PostgreSQL with encrypted, tested backups; restrict database users per service.
5. Test in real browsers, then `CSP_MODE=enforce`.
6. Obtain legal review of the privacy notice and retention period (Kenya Data Protection Act, 2019); complete a data protection impact assessment.
7. Rotate keys by publishing a second key in JWKS before retiring the first (planned).

## Known limits
Access tokens cannot be revoked before they expire (10 minutes). Rate limits are per process. Browser location can be spoofed. The activation code is as secure as the way it is handed over.
