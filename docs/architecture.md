# Architecture

## Principles
1. **One identity for the whole suite.** Identity issues short-lived signed access tokens. Every other service verifies them locally with Identity's public key (`/.well-known/jwks.json`); it never calls Identity on each request.
2. **Each service owns its data.** One database per service. No service reads another's tables. Cross-service needs go through an API or an event.
3. **Few services, clear boundaries.** Add a service only when a module needs it. Built: Identity, Attendance. Planned order: Notifications, then the ERP spine (employee directory, leave, payroll inputs, finance, inventory).
4. **Tenant-aware everywhere.** Every record carries a tenant (organisation) id taken from the verified token, never from the request body.
5. **Configuration over code.** Organisation rules (shifts, verification policy, roles) are data.
6. **Browser never holds tokens.** The Portal acts as a backend-for-frontend: tokens live in httpOnly cookies and are renewed by middleware.

## Service map (now and next)
```
Browser ──> Portal (Next.js, BFF) ──> Identity   ──> PostgreSQL (identity)
                         │
                         └──────────> Attendance ──> PostgreSQL (attendance)
Attendance ── verifies tokens with Identity's public key (JWKS)
Attendance ── asks Identity for the caller's team (interim; replaced by events and a local copy)
Events (next): Identity ──RabbitMQ──> Notifications, Attendance, HR
```

## Communication
- Questions (read data now): REST over HTTP, contracts in OpenAPI.
- Announcements (something happened): events on RabbitMQ, JSON with a version field, designed so consumers can be added without changing the producer.
- Every request carries a correlation id (to add with OpenTelemetry).

## Conventions
- TypeScript everywhere; NestJS services; strict mode.
- Roles: `worker`, `supervisor`, `management`, `admin`, scoped to one organisation.
- Errors do not reveal whether an account exists.
- Secrets only from environment or a secret manager.
