# Logging, correlation IDs and request tracing

**Status:** implemented in Stage 1.

## What is in place

### Structured JSON logs

Both services log one JSON object per line:

```json
{
  "ts": "2026-11-04T09:15:22.481Z",
  "level": "log",
  "ctx": "AttendanceService",
  "msg": "..."
}
```

- `ts` — ISO 8601 UTC timestamp
- `level` — `log` | `error` | `warn` | `debug` (`debug` only when `LOG_LEVEL=debug`)
- `ctx` — NestJS logger context (class name)
- `msg` — the message; stack traces are compacted into `stack` (first 6 frames)

Nest lifecycle noise is replaced by this logger via `NestFactory.create(AppModule, { logger })`
in both `main.ts` files.

### Correlation IDs

Every HTTP request gets a correlation id:

1. The Portal BFF mints one per browser request (`crypto.randomUUID()`) or reuses an
   incoming `x-correlation-id` header, and sends it to the service.
2. The service's `CorrelationIdMiddleware` accepts an incoming `x-correlation-id`
   (8–128 chars) or mints a UUID, stores it on the request object, and echoes it in
   the `x-correlation-id` response header.
3. Controllers pass it into service methods; critical audit records store it in
   `audit_events.metadata.correlationId`.
4. The BFF echoes the id back to the browser in the API response header.

## How to trace one request across services

1. Get the correlation id from the browser's failed request (response header
   `x-correlation-id`) or from any service log line for the failure.
2. In the Portal/BFF and service logs, search for that id:
   ```powershell
   Select-String -Path logs\attendance.log -Pattern "CORRELATION-ID-HERE"
   ```
3. In the database, find the audit rows written by that request:
   ```sql
   SELECT action, target, metadata->>'correlationId' AS cid, created_at
   FROM audit_events
   WHERE metadata->>'correlationId' = 'CORRELATION-ID-HERE';
   ```
   This works across both services' audit tables (each service's own database).

## What must never be logged

- Passwords, PINs, activation codes, tokens (access or refresh), reset tokens
- Full GPS coordinate pairs in log lines (they are in the database under the
  retention policy; logs are not subject to the same purge)
- Staff numbers in messages that also carry failure reasons (log ids, not
  identity+failure together, where avoidable)

Audit metadata is for _who did what to which record and why_ — never secrets.
