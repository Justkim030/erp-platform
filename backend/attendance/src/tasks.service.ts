import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from './auth';
import { Db } from './db';
import { CreateTaskDto, TaskProgressDto, UpdateTaskDto } from './dto';
import { AuditService, Member, Roster, newId } from './support';

const TRANSITIONS: Record<string, string[]> = {
  assigned: ['in_progress', 'completed', 'blocked', 'cancelled'],
  in_progress: ['completed', 'blocked', 'cancelled'],
  blocked: ['in_progress', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

@Injectable()
export class TasksService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly roster: Roster,
  ) {}

  private async members(user: AuthUser): Promise<Member[]> {
    return this.roster.members(user);
  }

  private async canAccessWorker(user: AuthUser, workerId: string) {
    if (user.role === 'management' || user.role === 'admin') return true;
    if (user.role === 'worker') return user.sub === workerId;
    if (user.role !== 'supervisor') return false;
    return (await this.members(user)).some((m) => m.id === workerId && m.role === 'worker' && m.status === 'active');
  }

  private async assignedWorker(user: AuthUser, workerId: string) {
    if (!(await this.canAccessWorker(user, workerId))) throw new NotFoundException('Assignee not found in your scope.');
    const member = (await this.members(user)).find((m) => m.id === workerId);
    if (!member || member.role !== 'worker' || member.status !== 'active') throw new NotFoundException('Active worker not found.');
    return member;
  }

  async list(user: AuthUser, status?: string) {
    let rows: any[];
    if (user.role === 'worker') {
      rows = await this.db.query(
        `SELECT * FROM work_tasks WHERE tenant_id=$1 AND assigned_to=$2 ORDER BY due_date NULLS LAST,created_at DESC LIMIT 1000`,
        [user.tid, user.sub]);
    } else if (user.role === 'supervisor') {
      const workers = (await this.members(user)).filter((m) => m.role === 'worker' && m.status === 'active').map((m) => m.id);
      if (!workers.length) return [];
      rows = await this.db.query(
        `SELECT * FROM work_tasks WHERE tenant_id=$1 AND assigned_to = ANY($2) ORDER BY due_date NULLS LAST,created_at DESC LIMIT 1000`,
        [user.tid, workers]);
    } else if (user.role === 'management' || user.role === 'admin') {
      rows = await this.db.query(
        `SELECT * FROM work_tasks WHERE tenant_id=$1 ORDER BY due_date NULLS LAST,created_at DESC LIMIT 1000`, [user.tid]);
    } else throw new ForbiddenException();
    if (status && !['assigned', 'in_progress', 'completed', 'blocked', 'cancelled'].includes(status)) throw new BadRequestException('Unknown task status.');
    if (status) rows = rows.filter((row) => row.status === status);
    if (!rows.length) return [];
    const progress = await this.db.query(
      `SELECT id,task_id,actor_id AS "actorId",status,note,created_at AS "createdAt"
       FROM work_task_progress WHERE task_id=ANY($1) ORDER BY created_at,id`,
      [rows.map((row) => row.id)]);
    const byTask = new Map<string, any[]>();
    for (const entry of progress) {
      const history = byTask.get(entry.task_id) ?? [];
      history.push(entry);
      byTask.set(entry.task_id, history);
    }
    return rows.map((row) => ({ ...row, progress: byTask.get(row.id) ?? [] }));
  }

  async create(user: AuthUser, dto: CreateTaskDto, ip?: string, correlationId?: string) {
    if (user.role !== 'supervisor' && user.role !== 'management' && user.role !== 'admin') throw new ForbiddenException();
    const assignee = await this.assignedWorker(user, dto.assignedTo);
    if (dto.departmentId && assignee.departmentId !== dto.departmentId) throw new BadRequestException('The assignee is not in the selected department.');
    const id = newId();
    await this.db.tx(async (q) => {
      await q(
        `INSERT INTO work_tasks (id,tenant_id,title,description,priority,due_date,department_id,assigned_by,assigned_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, user.tid, dto.title.trim(), dto.description?.trim() || null, dto.priority ?? 'normal',
          dto.dueDate ?? null, dto.departmentId ?? assignee.departmentId ?? null, user.sub, assignee.id]);
      await q(
        `INSERT INTO work_task_progress (id,task_id,actor_id,status,note) VALUES ($1,$2,$3,'assigned',$4)`,
        [newId(), id, user.sub, 'Task assigned']);
      await this.audit.recordWithinTx(q, {
        tenantId: user.tid, actorId: user.sub, action: 'task.created', target: id,
        ip, correlationId, meta: { assignedTo: assignee.id, departmentId: dto.departmentId ?? assignee.departmentId ?? null },
      });
    });
    return this.get(user, id);
  }

  async get(user: AuthUser, id: string) {
    const task = (await this.db.query('SELECT * FROM work_tasks WHERE id=$1 AND tenant_id=$2', [id, user.tid]))[0];
    if (!task || !(await this.canAccessWorker(user, task.assigned_to))) throw new NotFoundException();
    const progress = await this.db.query(
      `SELECT id,actor_id AS "actorId",status,note,created_at AS "createdAt"
       FROM work_task_progress WHERE task_id=$1 ORDER BY created_at,id`, [id]);
    return { ...task, progress };
  }

  async update(user: AuthUser, id: string, dto: UpdateTaskDto, ip?: string, correlationId?: string) {
    if (user.role !== 'supervisor' && user.role !== 'management' && user.role !== 'admin') throw new ForbiddenException();
    const before = (await this.db.query('SELECT * FROM work_tasks WHERE id=$1 AND tenant_id=$2', [id, user.tid]))[0];
    if (!before || !(await this.canAccessWorker(user, before.assigned_to))) throw new NotFoundException();
    const assigneeId = dto.assignedTo ?? before.assigned_to;
    const assignee = await this.assignedWorker(user, assigneeId);
    if (dto.departmentId && assignee.departmentId !== dto.departmentId) throw new BadRequestException('The assignee is not in the selected department.');
    await this.db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`task:${id}`]);
      const task = (await q('SELECT * FROM work_tasks WHERE id=$1 AND tenant_id=$2', [id, user.tid]))[0];
      if (!task || task.assigned_to !== before.assigned_to) throw new ConflictException('The task assignment changed. Refresh and try again.');
      const departmentId = dto.departmentId === undefined ? (assignee.departmentId ?? task.department_id) : dto.departmentId;
      await q(
        `UPDATE work_tasks SET title=$3,description=$4,priority=$5,due_date=$6,department_id=$7,assigned_to=$8,updated_at=now()
         WHERE id=$1 AND tenant_id=$2`,
        [id, user.tid, dto.title?.trim() ?? task.title, dto.description === undefined ? task.description : dto.description?.trim() || null,
          dto.priority ?? task.priority, dto.dueDate === undefined ? task.due_date : dto.dueDate,
          departmentId, assigneeId]);
      if (assigneeId !== task.assigned_to) {
        await q(
          `INSERT INTO work_task_progress (id,task_id,actor_id,status,note) VALUES ($1,$2,$3,$4,$5)`,
          [newId(), id, user.sub, task.status, `Reassigned to ${assigneeId}`]);
      }
      await this.audit.recordWithinTx(q, {
        tenantId: user.tid, actorId: user.sub, action: 'task.updated', target: id,
        ip, correlationId, meta: { assignedTo: assigneeId, previousAssignee: task.assigned_to },
      });
    });
    return this.get(user, id);
  }

  async updateProgress(user: AuthUser, id: string, dto: TaskProgressDto, ip?: string, correlationId?: string) {
    const before = (await this.db.query('SELECT assigned_to FROM work_tasks WHERE id=$1 AND tenant_id=$2', [id, user.tid]))[0];
    if (!before || !(await this.canAccessWorker(user, before.assigned_to))) throw new NotFoundException();
    return this.db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`task:${id}`]);
      const task = (await q('SELECT * FROM work_tasks WHERE id=$1 AND tenant_id=$2', [id, user.tid]))[0];
      if (!task || task.assigned_to !== before.assigned_to) throw new NotFoundException();
      if (!TRANSITIONS[task.status]?.includes(dto.status)) throw new ConflictException(`A task cannot move from ${task.status} to ${dto.status}.`);
      await q(`UPDATE work_tasks SET status=$2,updated_at=now() WHERE id=$1`, [id, dto.status]);
      await q(
        `INSERT INTO work_task_progress (id,task_id,actor_id,status,note) VALUES ($1,$2,$3,$4,$5)`,
        [newId(), id, user.sub, dto.status, dto.note?.trim() ?? null]);
      await this.audit.recordWithinTx(q, {
        tenantId: user.tid, actorId: user.sub, action: 'task.progress_updated', target: id,
        ip, correlationId, meta: { previousStatus: task.status, newStatus: dto.status },
      });
      return { id, status: dto.status };
    });
  }
}
