// Each migration is a list of single statements, applied once, in order.
export const MIGRATIONS: { id: string; statements: string[] }[] = [
  {
    id: '001_init',
    statements: [
      `CREATE TABLE tenants (
        id text PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL,
        status text NOT NULL DEFAULT 'active', created_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE TABLE users (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id),
        staff_number text NOT NULL, full_name text NOT NULL, email text, phone text,
        role text NOT NULL, status text NOT NULL, password_hash text,
        failed_attempts integer NOT NULL DEFAULT 0, locked_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz,
        UNIQUE (tenant_id, staff_number))`,
      `CREATE TABLE invites (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id),
        user_id text NOT NULL REFERENCES users(id), code_hash text NOT NULL,
        expires_at timestamptz NOT NULL, used_at timestamptz, created_by text,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, code_hash))`,
      `CREATE TABLE refresh_tokens (
        id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), tenant_id text NOT NULL,
        family_id text NOT NULL, token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
        used_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
        ip text, user_agent text)`,
      `CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id)`,
      `CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id)`,
      `CREATE TABLE password_resets (
        id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
        token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
        used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE TABLE audit_events (
        id text PRIMARY KEY, tenant_id text, actor_id text, action text NOT NULL, target text,
        ip text, user_agent text, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now())`,
      `CREATE INDEX audit_tenant_time ON audit_events (tenant_id, created_at)`,
    ],
  },
  {
    id: '002_team_and_credentials',
    statements: [
      `ALTER TABLE users ADD COLUMN supervisor_id text`,
      `ALTER TABLE users ADD COLUMN credential_type text`,
      `ALTER TABLE invites ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0`,
      `CREATE INDEX users_supervisor ON users (tenant_id, supervisor_id)`,
    ],
  },
  {
    id: '003_organisation_structure',
    statements: [
      // Departments: created and managed by management/admin. `code` is optional but
      // unique per tenant when present. A department may have a manager (a user id).
      `CREATE TABLE departments (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id),
        name text NOT NULL, code text, active boolean NOT NULL DEFAULT true,
        manager_user_id text REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, name))`,
      `CREATE UNIQUE INDEX departments_tenant_code ON departments (tenant_id, code) WHERE code IS NOT NULL`,
      `CREATE INDEX departments_tenant ON departments (tenant_id) WHERE active = true`,
      `ALTER TABLE users ADD COLUMN department_id text REFERENCES departments(id)`,
      `ALTER TABLE users ADD COLUMN job_title text`,
      `CREATE INDEX users_department ON users (tenant_id, department_id)`,
      // Supervisor assignments: the historical source of truth for who supervised whom,
      // when. users.supervisor_id remains the current-pointer cache for fast reads.
      `CREATE TABLE supervisor_assignments (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id),
        supervisor_id text NOT NULL REFERENCES users(id),
        worker_id text NOT NULL REFERENCES users(id),
        assigned_by text, assigned_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz, end_reason text,
        CHECK (supervisor_id <> worker_id))`,
      `CREATE INDEX supervisor_assignments_worker ON supervisor_assignments (tenant_id, worker_id, assigned_at)`,
      `CREATE INDEX supervisor_assignments_supervisor ON supervisor_assignments (tenant_id, supervisor_id, assigned_at)`,
      `CREATE INDEX supervisor_assignments_open ON supervisor_assignments (worker_id) WHERE ended_at IS NULL`,
      // Employee status history: every status change with who made it and why.
      `CREATE TABLE employee_status_history (
        id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id),
        user_id text NOT NULL REFERENCES users(id),
        status text NOT NULL, previous_status text,
        effective_from timestamptz NOT NULL DEFAULT now(),
        changed_by text, reason text,
        correlation_id text)` ,
      `CREATE INDEX employee_status_history_user ON employee_status_history (tenant_id, user_id, effective_from)`,
    ],
  },
];
