import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from './audit';
import { AppConfig, CONFIG } from './config';
import { Db, Q } from './db';
import { CreateUserDto, DepartmentDto, PlatformOrgDto, PlatformUserDto, ReassignDto, StatusChangeDto } from './dto';
import { AuthUser } from './guards';
import { Role, inviteCode, newId, normaliseInvite, sha256 } from './security';

const DAY = 86_400_000;
const publicRow = (u: any) => ({
  id: u.id, staffNumber: u.staff_number, fullName: u.full_name, role: u.role, status: u.status,
  supervisorId: u.supervisor_id ?? null, departmentId: u.department_id ?? null, jobTitle: u.job_title ?? null,
  phone: u.phone ?? null, createdAt: u.created_at,
});

@Injectable()
export class AdminService {
  constructor(private readonly db: Db, private readonly audit: AuditService, @Inject(CONFIG) private readonly cfg: AppConfig) {}

  /** Closes any open code for the user and issues a fresh one. Only the hash is stored; the code is shown once. */
  private async issueCode(q: Q, tenantId: string, userId: string, createdBy: string | null) {
    const code = inviteCode();
    const expiresAt = new Date(Date.now() + 7 * DAY);
    await q('UPDATE invites SET used_at=$2 WHERE user_id=$1 AND used_at IS NULL', [userId, new Date()]);
    await q('INSERT INTO invites (id,tenant_id,user_id,code_hash,expires_at,created_by) VALUES ($1,$2,$3,$4,$5,$6)', [
      newId(), tenantId, userId, sha256(normaliseInvite(code)), expiresAt, createdBy,
    ]);
    return { activationCode: code, expiresAt };
  }

  private async insertUser(q: Q, tenantId: string, d: { staffNumber: string; fullName: string; role: Role; supervisorId: string | null; departmentId?: string | null; jobTitle?: string | null; email?: string; phone?: string }) {
    const id = newId();
    await q(`INSERT INTO users (id,tenant_id,staff_number,full_name,email,phone,role,status,supervisor_id,department_id,job_title) VALUES ($1,$2,$3,$4,$5,$6,$7,'invited',$8,$9,$10)`,
      [id, tenantId, d.staffNumber, d.fullName, d.email ?? null, d.phone ?? null, d.role, d.supervisorId, d.departmentId ?? null, d.jobTitle ?? null]);
    return id;
  }

  // ---- UI-facing: supervisors add their own workers; management and admin add more
  async createUser(actor: AuthUser, dto: CreateUserDto, ip?: string, correlationId?: string) {
    if (actor.role === 'supervisor' && dto.role !== 'worker') throw new ForbiddenException();
    if (actor.role === 'management' && dto.role !== 'worker' && dto.role !== 'supervisor') throw new ForbiddenException();
    let supervisorId: string | null = null;
    if (dto.role === 'worker') {
      supervisorId = actor.role === 'supervisor' ? actor.sub : dto.supervisorId ?? null;
      if (!supervisorId && actor.role !== 'supervisor' &&
          (await this.db.query(`SELECT id FROM users WHERE tenant_id=$1 AND role='supervisor' AND status='active' LIMIT 1`, [actor.tid])).length) {
        throw new BadRequestException('Assign this worker to an active supervisor.');
      }
      if (supervisorId && !(await this.db.query(`SELECT id FROM users WHERE id=$1 AND tenant_id=$2 AND role='supervisor' AND status='active'`, [supervisorId, actor.tid])).length) {
        throw new NotFoundException('Supervisor not found.');
      }
    }
    // Departments are optional but, when given, must exist in the caller's tenant.
    if (dto.departmentId && !(await this.db.query(`SELECT id FROM departments WHERE id=$1 AND tenant_id=$2 AND active=true`, [dto.departmentId, actor.tid])).length) {
      throw new NotFoundException('Department not found.');
    }
    if ((await this.db.query('SELECT id FROM users WHERE tenant_id=$1 AND staff_number=$2', [actor.tid, dto.staffNumber])).length) {
      throw new ConflictException('A user with this staff number already exists.');
    }
    const result = await this.db.tx(async (q) => {
      const id = await this.insertUser(q, actor.tid, { ...dto, supervisorId });
      const code = await this.issueCode(q, actor.tid, id, actor.sub);
      // Supervisor assignment history starts here when the worker has a supervisor.
      if (supervisorId) {
        await q(`INSERT INTO supervisor_assignments (id,tenant_id,supervisor_id,worker_id,assigned_by) VALUES ($1,$2,$3,$4,$5)`,
          [newId(), actor.tid, supervisorId, id, actor.sub]);
      }
      // Critical action: the audit row commits or rolls back with the user record.
      await this.audit.recordWithinTx(q, { tenantId: actor.tid, actorId: actor.sub, action: 'user.created', target: dto.staffNumber, ip, correlationId,
        meta: { role: dto.role, newUserId: id, supervisorId, departmentId: dto.departmentId ?? null } });
      return { id, ...code };
    });
    return { user: { id: result.id, staffNumber: dto.staffNumber, fullName: dto.fullName, role: dto.role, status: 'invited', supervisorId, departmentId: dto.departmentId ?? null }, activationCode: result.activationCode, expiresAt: result.expiresAt };
  }

  /** Supervisors see their own team; management and admin see the organisation.
   *  Paginated: without `page`, returns the plain array (backward compatible, capped at
   *  one page of 200); with `page`, returns the envelope { items, page, pageSize, total }.
   *  Ordering is stable (created_at, id) so pages never duplicate or skip records. */
  async listUsers(actor: AuthUser, page?: number, pageSize = 50) {
    const where = actor.role === 'supervisor'
      ? { cond: 'tenant_id=$1 AND supervisor_id=$2', params: [actor.tid, actor.sub] }
      : { cond: 'tenant_id=$1', params: [actor.tid] };
    const capped = Math.min(Math.max(pageSize, 1), 200);
    if (page === undefined) {
      const rows = await this.db.query(
        `SELECT * FROM users WHERE ${where.cond} ORDER BY created_at, id LIMIT ${capped}`, where.params);
      return rows.map(publicRow);
    }
    const p = Math.max(page, 1);
    const totalRow = await this.db.query(`SELECT count(*)::int AS n FROM users WHERE ${where.cond}`, where.params);
    const rows = await this.db.query(
      `SELECT * FROM users WHERE ${where.cond} ORDER BY created_at, id LIMIT ${capped} OFFSET ${(p - 1) * capped}`, where.params);
    return { items: rows.map(publicRow), page: p, pageSize: capped, total: totalRow[0]?.n ?? 0 };
  }

  /** Lost PIN or password: clears the credential and issues a new one-time activation code. */
  async resetAccess(actor: AuthUser, userId: string, ip?: string) {
    const target = (await this.db.query('SELECT * FROM users WHERE id=$1 AND tenant_id=$2', [userId, actor.tid]))[0];
    if (!target || target.id === actor.sub) throw new NotFoundException();
    const allowed =
      (actor.role === 'supervisor' && target.role === 'worker' && target.supervisor_id === actor.sub) ||
      (actor.role === 'management' && (target.role === 'worker' || target.role === 'supervisor')) ||
      actor.role === 'admin';
    if (!allowed) throw new ForbiddenException();
    const result = await this.db.tx(async (q) => {
      await q(`UPDATE users SET status='invited', password_hash=NULL, credential_type=NULL, failed_attempts=0, locked_until=NULL WHERE id=$1`, [target.id]);
      await q('UPDATE refresh_tokens SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL', [target.id, new Date()]);
      const code = await this.issueCode(q, actor.tid, target.id, actor.sub);
      // Critical action: audit commits or rolls back with the credential reset.
      await this.audit.recordWithinTx(q, { tenantId: actor.tid, actorId: actor.sub, action: 'user.access_reset', target: target.staff_number, ip,
        meta: { targetUserId: target.id, targetRole: target.role, previousStatus: target.status, sessionsRevoked: true } });
      return code;
    });
    return { user: { id: target.id, staffNumber: target.staff_number, fullName: target.full_name, role: target.role, status: 'invited' }, ...result };
  }

  // ---- Platform owner (hidden endpoints, never reachable from the UI)
  async createOrganisation(dto: PlatformOrgDto, ip?: string) {
    if ((await this.db.query('SELECT id FROM tenants WHERE slug=$1', [dto.slug])).length) throw new ConflictException('Organisation already exists.');
    const tenantId = newId();
    const result = await this.db.tx(async (q) => {
      await q('INSERT INTO tenants (id,slug,name) VALUES ($1,$2,$3)', [tenantId, dto.slug, dto.name]);
      const id = await this.insertUser(q, tenantId, { staffNumber: dto.adminStaffNumber, fullName: dto.adminName, role: 'admin', supervisorId: null, email: dto.adminEmail, phone: dto.adminPhone });
      const code = await this.issueCode(q, tenantId, id, null);
      await this.audit.recordWithinTx(q, { tenantId, action: 'organisation.created', target: dto.slug, ip, meta: { adminUserId: id } });
      return { id, ...code };
    });
    // The platform owner never sees the administrator's password: the administrator sets it on first sign-in.
    return { tenant: { id: tenantId, slug: dto.slug, name: dto.name }, admin: { id: result.id, staffNumber: dto.adminStaffNumber, role: 'admin' }, activationCode: result.activationCode, expiresAt: result.expiresAt };
  }

  async addPlatformUser(slug: string, dto: PlatformUserDto, ip?: string) {
    const t = (await this.db.query(`SELECT * FROM tenants WHERE slug=$1 AND status='active'`, [slug]))[0];
    if (!t) throw new NotFoundException();
    if ((await this.db.query('SELECT id FROM users WHERE tenant_id=$1 AND staff_number=$2', [t.id, dto.staffNumber])).length) throw new ConflictException('A user with this staff number already exists.');
    let supervisorId: string | null = null;
    if (dto.supervisorStaffNumber) {
      const s = (await this.db.query(`SELECT id FROM users WHERE tenant_id=$1 AND staff_number=$2 AND role='supervisor'`, [t.id, dto.supervisorStaffNumber]))[0];
      if (!s) throw new NotFoundException('Supervisor not found.');
      supervisorId = s.id;
    }
    const result = await this.db.tx(async (q) => {
      const id = await this.insertUser(q, t.id, { ...dto, supervisorId });
      const code = await this.issueCode(q, t.id, id, null);
      if (supervisorId) {
        await q(`INSERT INTO supervisor_assignments (id,tenant_id,supervisor_id,worker_id,assigned_by) VALUES ($1,$2,$3,$4,$5)`,
          [newId(), t.id, supervisorId, id, null]);
      }
      await this.audit.recordWithinTx(q, { tenantId: t.id, action: 'platform.user_created', target: dto.staffNumber, ip, meta: { role: dto.role, newUserId: id, supervisorId } });
      return { id, ...code };
    });
    return { user: { id: result.id, staffNumber: dto.staffNumber, fullName: dto.fullName, role: dto.role, status: 'invited' }, activationCode: result.activationCode, expiresAt: result.expiresAt };
  }

  // ---- Stage 2: organisation structure
  /** Create or update a department. Management and admin only. */
  async saveDepartment(actor: AuthUser, dto: DepartmentDto, id: string | undefined, ip?: string, correlationId?: string) {
    if (dto.managerUserId) {
      const m = (await this.db.query('SELECT id FROM users WHERE id=$1 AND tenant_id=$2', [dto.managerUserId, actor.tid]))[0];
      if (!m) throw new NotFoundException('Manager not found.');
    }
    try {
      return await this.db.tx(async (q) => {
        let deptId = id;
        if (id) {
          const r = await q(
            `UPDATE departments SET name=$3, code=$4, manager_user_id=$5 WHERE id=$1 AND tenant_id=$2 RETURNING id`,
            [id, actor.tid, dto.name, dto.code ?? null, dto.managerUserId ?? null]);
          if (!r.length) throw new NotFoundException('Department not found.');
        } else {
          deptId = newId();
          await q(`INSERT INTO departments (id,tenant_id,name,code,manager_user_id) VALUES ($1,$2,$3,$4,$5)`,
            [deptId, actor.tid, dto.name, dto.code ?? null, dto.managerUserId ?? null]);
        }
        await this.audit.recordWithinTx(q, { tenantId: actor.tid, actorId: actor.sub, action: id ? 'department.updated' : 'department.created', target: deptId, ip, correlationId,
          meta: { name: dto.name, code: dto.code ?? null, managerUserId: dto.managerUserId ?? null } });
        const r = (await q('SELECT * FROM departments WHERE id=$1', [deptId]))[0];
        return { id: r.id, name: r.name, code: r.code ?? null, managerUserId: r.manager_user_id ?? null, active: r.active, createdAt: r.created_at };
      });
    } catch (e: any) {
      // Unique constraints on (tenant_id, name) and (tenant_id, code) surface as 23505.
      if (e?.code === '23505') throw new ConflictException('A department with this name or code already exists.');
      throw e;
    }
  }

  async listDepartments(actor: AuthUser, includeInactive = false) {
    const rows = await this.db.query(
      `SELECT * FROM departments WHERE tenant_id=$1 ${includeInactive ? '' : 'AND active=true'} ORDER BY name`, [actor.tid]);
    return rows.map((r: any) => ({ id: r.id, name: r.name, code: r.code ?? null, managerUserId: r.manager_user_id ?? null, active: r.active, createdAt: r.created_at }));
  }

  /** Deactivate a department (soft delete: history must never be lost). */
  async deactivateDepartment(actor: AuthUser, id: string, ip?: string) {
    return this.db.tx(async (q) => {
      const r = await q(`UPDATE departments SET active=false WHERE id=$1 AND tenant_id=$2 AND active=true RETURNING id`, [id, actor.tid]);
      if (!r.length) throw new NotFoundException('Department not found (or already inactive).');
      await this.audit.recordWithinTx(q, { tenantId: actor.tid, actorId: actor.sub, action: 'department.deactivated', target: id, ip,
        meta: {} });
      return { id, active: false };
    });
  }

  /** Reassign a worker to a new supervisor: closes the open assignment, opens a new one,
   *  updates the pointer, and audits the change with the reason. Management/admin only
   *  (a supervisor cannot reassign people between teams). */
  async reassignWorker(actor: AuthUser, workerId: string, dto: ReassignDto, ip?: string, correlationId?: string) {
    return this.db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`reassign:${workerId}`]);
      const worker = (await q('SELECT * FROM users WHERE id=$1 AND tenant_id=$2', [workerId, actor.tid]))[0];
      if (!worker || worker.role !== 'worker') throw new NotFoundException('Worker not found.');
      const sup = (await q(`SELECT * FROM users WHERE id=$1 AND tenant_id=$2 AND role='supervisor' AND status='active'`, [dto.supervisorId, actor.tid]))[0];
      if (!sup) throw new NotFoundException('Supervisor not found.');
      if (worker.supervisor_id === sup.id) return { workerId, supervisorId: sup.id, changed: false };
      const previousSupervisorId = worker.supervisor_id;
      const now = new Date();
      if (previousSupervisorId) {
        await q(`UPDATE supervisor_assignments SET ended_at=$3, end_reason=$4 WHERE worker_id=$1 AND tenant_id=$2 AND ended_at IS NULL`,
          [workerId, actor.tid, now, dto.reason ?? 'reassigned']);
      }
      await q(`INSERT INTO supervisor_assignments (id,tenant_id,supervisor_id,worker_id,assigned_by) VALUES ($1,$2,$3,$4,$5)`,
        [newId(), actor.tid, sup.id, workerId, actor.sub]);
      await q(`UPDATE users SET supervisor_id=$2 WHERE id=$1`, [workerId, sup.id]);
      await this.audit.recordWithinTx(q, { tenantId: actor.tid, actorId: actor.sub, action: 'worker.reassigned', target: worker.staff_number, ip, correlationId,
        meta: { workerId, previousSupervisorId, newSupervisorId: sup.id, reason: dto.reason ?? null } });
      return { workerId, supervisorId: sup.id, previousSupervisorId, changed: true };
    });
  }

  /** Assignment history for one worker. Management/admin see anyone; supervisors only their own workers. */
  async assignmentHistory(actor: AuthUser, workerId: string) {
    const worker = (await this.db.query('SELECT * FROM users WHERE id=$1 AND tenant_id=$2', [workerId, actor.tid]))[0];
    if (!worker) throw new NotFoundException();
    if (actor.role === 'supervisor' && worker.supervisor_id !== actor.sub) throw new ForbiddenException();
    const rows = await this.db.query(
      `SELECT a.id, a.supervisor_id, a.assigned_at, a.assigned_by, a.ended_at, a.end_reason, s.full_name AS supervisor_name
       FROM supervisor_assignments a
       LEFT JOIN users s ON s.id = a.supervisor_id
       WHERE a.worker_id=$1 AND a.tenant_id=$2 ORDER BY a.assigned_at`, [workerId, actor.tid]);
    return rows.map((r: any) => ({
      id: r.id, supervisorId: r.supervisor_id, supervisorName: r.supervisor_name,
      assignedAt: r.assigned_at, assignedBy: r.assigned_by ?? null, endedAt: r.ended_at ?? null, endReason: r.end_reason ?? null,
    }));
  }

  /** Employee status change (e.g. deactivation when someone leaves). Management/admin only.
   *  Deactivation revokes all sessions immediately. History row + audit written in the same tx. */
  async changeStatus(actor: AuthUser, userId: string, dto: StatusChangeDto, ip?: string, correlationId?: string) {
    return this.db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`status:${userId}`]);
      const target = (await q('SELECT * FROM users WHERE id=$1 AND tenant_id=$2', [userId, actor.tid]))[0];
      if (!target) throw new NotFoundException();
      if (target.id === actor.sub) throw new ForbiddenException('You cannot change your own status.');
      if (actor.role === 'management' && (target.role === 'management' || target.role === 'admin')) throw new ForbiddenException();
      if (target.status === dto.status) return { userId, status: dto.status, changed: false };
      const now = new Date();
      await q(`UPDATE users SET status=$2 WHERE id=$1`, [userId, dto.status]);
      if (dto.status === 'deactivated') {
        await q('UPDATE refresh_tokens SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL', [userId, now]);
      }
      await q(`INSERT INTO employee_status_history (id,tenant_id,user_id,status,previous_status,effective_from,changed_by,reason,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId(), actor.tid, userId, dto.status, target.status, now, actor.sub, dto.reason ?? null, correlationId ?? null]);
      await this.audit.recordWithinTx(q, { tenantId: actor.tid, actorId: actor.sub, action: 'user.status_changed', target: target.staff_number, ip, correlationId,
        meta: { userId, previousStatus: target.status, newStatus: dto.status, reason: dto.reason ?? null } });
      return { userId, status: dto.status, previousStatus: target.status, changed: true };
    });
  }

  /** Status history for one user. Same visibility rules as assignment history. */
  async statusHistory(actor: AuthUser, userId: string) {
    const target = (await this.db.query('SELECT * FROM users WHERE id=$1 AND tenant_id=$2', [userId, actor.tid]))[0];
    if (!target) throw new NotFoundException();
    if (actor.role === 'supervisor' && target.supervisor_id !== actor.sub) throw new ForbiddenException();
    const rows = await this.db.query(
      `SELECT * FROM employee_status_history WHERE user_id=$1 AND tenant_id=$2 ORDER BY effective_from`, [userId, actor.tid]);
    return rows.map((r: any) => ({
      id: r.id, status: r.status, previousStatus: r.previous_status, effectiveFrom: r.effective_from,
      changedBy: r.changed_by ?? null, reason: r.reason ?? null,
    }));
  }
}
