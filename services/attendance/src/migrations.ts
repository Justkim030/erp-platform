export const MIGRATIONS: { id: string; statements: string[] }[] = [
  {
    id: '001_init',
    statements: [
      `CREATE TABLE sites (
        id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL,
        lat double precision NOT NULL, lng double precision NOT NULL, radius_m integer NOT NULL,
        accuracy_limit_m integer NOT NULL DEFAULT 100, timezone text NOT NULL DEFAULT 'Africa/Nairobi',
        shift_start text NOT NULL DEFAULT '08:00', grace_minutes integer NOT NULL DEFAULT 10,
        allowed_ips text NOT NULL DEFAULT '[]', require_network boolean NOT NULL DEFAULT false,
        active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE INDEX sites_tenant ON sites (tenant_id)`,
      // Append-only record of clock-in and clock-out. Corrections are made by review decisions, never by editing the original.
      `CREATE TABLE attendance_events (
        id text PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, site_id text NOT NULL REFERENCES sites(id),
        kind text NOT NULL, occurred_at timestamptz NOT NULL,
        lat double precision, lng double precision, accuracy_m double precision, distance_m integer,
        outcome text NOT NULL, reasons text NOT NULL DEFAULT '[]', is_late boolean NOT NULL DEFAULT false,
        work_summary text, ip text, user_agent text,
        reviewed_by text, reviewed_at timestamptz, review_decision text, review_note text,
        created_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE INDEX events_user_time ON attendance_events (tenant_id, user_id, occurred_at)`,
      `CREATE INDEX events_tenant_time ON attendance_events (tenant_id, occurred_at)`,
      `CREATE TABLE audit_events (
        id text PRIMARY KEY, tenant_id text, actor_id text, action text NOT NULL, target text,
        ip text, user_agent text, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now())`,
    ],
  },
];
// NOTE on database-level enforcement of "one open session per worker":
// A partial unique index cannot express "no later clock-out exists" (index predicates
// cannot reference other rows), so a schema-level backstop arrives with the
// attendance_sessions table in Stage 3 (UNIQUE (tenant_id, user_id) WHERE status='open').
// Until then the invariant is enforced by the application transaction below
// (advisory lock serialises the check-then-insert per user), which is correct
// for all application writes; only manual/ad-hoc writes could bypass it.
