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
  {
    id: '002_sessions_exceptions_verifications',
    statements: [
      `CREATE TABLE attendance_sessions (
        id text PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL,
        site_id text NOT NULL REFERENCES sites(id),
        status text NOT NULL CHECK (status IN ('open','closed','needs_review','void')),
        started_at timestamptz NOT NULL, ended_at timestamptz,
        is_legacy boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((status = 'open' AND ended_at IS NULL) OR (status <> 'open' AND ended_at IS NOT NULL)))`,
      `CREATE UNIQUE INDEX attendance_sessions_one_open ON attendance_sessions (tenant_id, user_id) WHERE status = 'open'`,
      `CREATE INDEX attendance_sessions_user_time ON attendance_sessions (tenant_id, user_id, started_at)`,
      `ALTER TABLE attendance_events ADD COLUMN session_id text REFERENCES attendance_sessions(id)`,
      `CREATE INDEX attendance_events_session ON attendance_events (session_id)`,
      `CREATE TABLE attendance_session_backfill (
        id text PRIMARY KEY, completed_at timestamptz)`,
      `INSERT INTO attendance_session_backfill (id, completed_at) VALUES ('legacy', NULL)`,
      `CREATE TABLE attendance_exceptions (
        id text PRIMARY KEY, tenant_id text NOT NULL, worker_id text NOT NULL,
        session_id text REFERENCES attendance_sessions(id),
        event_id text REFERENCES attendance_events(id),
        exception_type text NOT NULL CHECK (exception_type IN ('missed_clock_in','missed_clock_out','location_issue','other')),
        occurred_at timestamptz NOT NULL, site_id text REFERENCES sites(id),
        reason text NOT NULL, work_summary text,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','needs_info','approved','declined')),
        reviewer_id text, reviewed_at timestamptz, review_note text,
        created_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE INDEX attendance_exceptions_tenant_status ON attendance_exceptions (tenant_id, status, created_at)`,
      `CREATE INDEX attendance_exceptions_worker_time ON attendance_exceptions (tenant_id, worker_id, created_at)`,
      `CREATE TABLE physical_verifications (
        id text PRIMARY KEY, tenant_id text NOT NULL,
        session_id text REFERENCES attendance_sessions(id),
        event_id text REFERENCES attendance_events(id),
        exception_id text REFERENCES attendance_exceptions(id),
        worker_id text NOT NULL, supervisor_id text NOT NULL,
        verified_at timestamptz NOT NULL DEFAULT now(),
        outcome text NOT NULL CHECK (outcome IN ('confirmed','not_found')),
        method text NOT NULL DEFAULT 'in_person' CHECK (method = 'in_person'),
        note text, created_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((event_id IS NOT NULL AND exception_id IS NULL) OR (event_id IS NULL AND exception_id IS NOT NULL)))`,
      `CREATE INDEX physical_verifications_session ON physical_verifications (tenant_id, session_id, verified_at)`,
      `CREATE INDEX physical_verifications_worker_time ON physical_verifications (tenant_id, worker_id, verified_at)`,
    ],
  },
  {
    id: '003_daily_work_reports',
    statements: [
      `CREATE TABLE work_reports (
        id text PRIMARY KEY, tenant_id text NOT NULL,
        session_id text NOT NULL UNIQUE REFERENCES attendance_sessions(id),
        worker_id text NOT NULL,
        status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','acknowledged','clarification','rejected')),
        submitted_at timestamptz, reviewer_id text, reviewed_at timestamptz, review_note text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE INDEX work_reports_tenant_status ON work_reports (tenant_id, status, updated_at)`,
      `CREATE INDEX work_reports_worker_time ON work_reports (tenant_id, worker_id, created_at)`,
      `CREATE TABLE work_report_items (
        id text PRIMARY KEY, report_id text NOT NULL REFERENCES work_reports(id) ON DELETE CASCADE,
        description text NOT NULL, activity_status text NOT NULL CHECK (activity_status IN ('completed','in_progress','blocked')),
        quantity numeric CHECK (quantity IS NULL OR quantity >= 0),
        unit text, challenge text, notes text,
        position integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE INDEX work_report_items_report ON work_report_items (report_id, position, created_at)`,
      `CREATE TABLE work_report_revisions (
        id text PRIMARY KEY, report_id text NOT NULL REFERENCES work_reports(id) ON DELETE CASCADE,
        revision integer NOT NULL, snapshot jsonb NOT NULL, created_by text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (report_id, revision))`,
      `CREATE TABLE work_report_reviews (
        id text PRIMARY KEY, report_id text NOT NULL REFERENCES work_reports(id) ON DELETE CASCADE,
        reviewer_id text NOT NULL, decision text NOT NULL CHECK (decision IN ('acknowledged','clarification','rejected')),
        note text, created_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE INDEX work_report_reviews_report ON work_report_reviews (report_id, created_at)`,
    ],
  },
  {
    id: '004_work_tasks',
    statements: [
      `CREATE TABLE work_tasks (
        id text PRIMARY KEY, tenant_id text NOT NULL,
        title text NOT NULL, description text, priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
        due_date date, department_id text, assigned_by text NOT NULL, assigned_to text NOT NULL,
        status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','completed','blocked','cancelled')),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE INDEX work_tasks_assignee_status ON work_tasks (tenant_id, assigned_to, status, due_date)`,
      `CREATE INDEX work_tasks_department ON work_tasks (tenant_id, department_id, status)`,
      `CREATE TABLE work_task_progress (
        id text PRIMARY KEY, task_id text NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
        actor_id text NOT NULL, status text NOT NULL CHECK (status IN ('assigned','in_progress','completed','blocked','cancelled')),
        note text, created_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE INDEX work_task_progress_task ON work_task_progress (task_id, created_at)`,
      `ALTER TABLE work_report_items ADD COLUMN task_id text REFERENCES work_tasks(id)`,
      `CREATE INDEX work_report_items_task ON work_report_items (task_id)`,
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
