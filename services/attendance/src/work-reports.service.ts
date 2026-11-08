import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from './auth';
import { AppConfig, CONFIG } from './config';
import { Db, Q } from './db';
import { WorkReportDto, WorkReportReviewDto } from './dto';
import { AuditService, Member, Roster, newId } from './support';

const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(',');

@Injectable()
export class WorkReportsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly roster: Roster,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  private async inWorkerScope(user: AuthUser, workerId: string) {
    if (user.role === 'worker') return user.sub === workerId;
    if (user.role === 'management' || user.role === 'admin') return true;
    if (user.role !== 'supervisor') return false;
    const members = await this.roster.members(user);
    return members.some((m) => m.id === workerId && m.role === 'worker' && m.status === 'active');
  }

  private async items(reportId: string, q: Q = this.db.query) {
    return q(
      `SELECT i.id,i.description,i.activity_status AS "status",i.quantity,i.unit,i.challenge,i.notes,i.position,
       i.task_id AS "taskId",t.title AS "taskTitle"
       FROM work_report_items i LEFT JOIN work_tasks t ON t.id=i.task_id
       WHERE i.report_id=$1 ORDER BY i.position,i.created_at`, [reportId]);
  }

  private async revision(q: Q, reportId: string, actorId: string) {
    const previous = (await q('SELECT COALESCE(MAX(revision),0)::int AS revision FROM work_report_revisions WHERE report_id=$1', [reportId]))[0];
    const items = await this.items(reportId, q);
    await q(
      `INSERT INTO work_report_revisions (id,report_id,revision,snapshot,created_by) VALUES ($1,$2,$3,$4,$5)`,
      [newId(), reportId, previous.revision + 1, JSON.stringify(items), actorId]);
  }

  async saveDraft(user: AuthUser, dto: WorkReportDto, reportId?: string, ip?: string, correlationId?: string) {
    if (user.role !== 'worker') throw new ForbiddenException();
    try {
      const id = await this.db.tx(async (q) => {
        const session = (await q(
          `SELECT status,ended_at FROM attendance_sessions WHERE id=$1 AND tenant_id=$2 AND user_id=$3`,
          [dto.sessionId, user.tid, user.sub]))[0];
        if (!session) throw new NotFoundException('Attendance session not found.');
        if (!session.ended_at || !['closed', 'needs_review'].includes(session.status)) {
          throw new ConflictException('Submit your end-of-shift report after clocking out.');
        }
        let current: any;
        let savedId: string;
        if (reportId) {
          savedId = reportId;
          current = (await q('SELECT * FROM work_reports WHERE id=$1 AND tenant_id=$2 AND worker_id=$3', [reportId, user.tid, user.sub]))[0];
          if (!current) throw new NotFoundException();
          if (current.session_id !== dto.sessionId) throw new BadRequestException('The report cannot be moved to another attendance session.');
          if (!['draft', 'clarification', 'rejected'].includes(current.status)) throw new ConflictException('This report can no longer be edited.');
          await q(
            `UPDATE work_reports SET status='draft',submitted_at=NULL,reviewer_id=NULL,reviewed_at=NULL,review_note=NULL,updated_at=now() WHERE id=$1`,
            [reportId]);
        } else {
          const createdId = newId();
          savedId = createdId;
          await q(
            `INSERT INTO work_reports (id,tenant_id,session_id,worker_id,status) VALUES ($1,$2,$3,$4,'draft')`,
            [createdId, user.tid, dto.sessionId, user.sub]);
        }
        await q('DELETE FROM work_report_items WHERE report_id=$1', [savedId]);
        for (const [position, activity] of dto.activities.entries()) {
          if (activity.taskId) {
            const task = (await q(
              `SELECT id,status FROM work_tasks WHERE id=$1 AND tenant_id=$2 AND assigned_to=$3`,
              [activity.taskId, user.tid, user.sub]))[0];
            if (!task || task.status === 'cancelled') throw new BadRequestException('Choose an active task assigned to you.');
          }
          await q(
            `INSERT INTO work_report_items (id,report_id,description,activity_status,quantity,unit,challenge,notes,position,task_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [newId(), savedId, activity.description.trim(), activity.status, activity.quantity ?? null,
              activity.unit?.trim() || null, activity.challenge?.trim() || null, activity.notes?.trim() || null, position, activity.taskId ?? null]);
        }
        await this.revision(q, savedId, user.sub);
        await this.audit.recordWithinTx(q, {
          tenantId: user.tid, actorId: user.sub, action: current ? 'work_report.updated' : 'work_report.created',
          target: savedId, ip, correlationId, meta: { sessionId: dto.sessionId, activities: dto.activities.length },
        });
        return savedId;
      });
      return this.getReport(user, id);
    } catch (error: any) {
      if (error?.code === '23505') throw new ConflictException('A report already exists for this attendance session.');
      throw error;
    }
  }

  async submit(user: AuthUser, reportId: string, ip?: string, correlationId?: string) {
    return this.db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`work-report:${reportId}`]);
      const report = (await q(
        `SELECT r.*,s.status AS session_status,s.ended_at AS session_ended_at
         FROM work_reports r JOIN attendance_sessions s ON s.id=r.session_id
         WHERE r.id=$1 AND r.tenant_id=$2`, [reportId, user.tid]))[0];
      if (!report || report.worker_id !== user.sub || user.role !== 'worker') throw new NotFoundException();
      if (!report.session_ended_at || !['closed', 'needs_review'].includes(report.session_status)) {
        throw new ConflictException('Submit your end-of-shift report after clocking out.');
      }
      if (!['draft', 'clarification', 'rejected'].includes(report.status)) throw new ConflictException('This report is not ready to submit.');
      const count = (await q('SELECT count(*)::int AS n FROM work_report_items WHERE report_id=$1', [reportId]))[0]?.n ?? 0;
      if (!count) throw new BadRequestException('Add at least one activity before submitting.');
      await q(`UPDATE work_reports SET status='submitted',submitted_at=now(),updated_at=now() WHERE id=$1`, [reportId]);
      await this.audit.recordWithinTx(q, {
        tenantId: user.tid, actorId: user.sub, action: 'work_report.submitted',
        target: reportId, ip, correlationId, meta: { sessionId: report.session_id },
      });
      return { id: reportId, status: 'submitted' };
    });
  }

  async review(user: AuthUser, reportId: string, dto: WorkReportReviewDto, ip?: string, correlationId?: string) {
    if (user.role !== 'supervisor' && user.role !== 'management' && user.role !== 'admin') throw new ForbiddenException();
    const before = (await this.db.query(
      'SELECT worker_id FROM work_reports WHERE id=$1 AND tenant_id=$2', [reportId, user.tid]))[0];
    if (!before) throw new NotFoundException();
    if (!(await this.inWorkerScope(user, before.worker_id))) throw new NotFoundException();
    return this.db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`work-report:${reportId}`]);
      const report = (await q('SELECT * FROM work_reports WHERE id=$1 AND tenant_id=$2', [reportId, user.tid]))[0];
      if (!report) throw new NotFoundException();
      if (report.status !== 'submitted') throw new ConflictException('Only submitted reports can be reviewed.');
      await q(
        `UPDATE work_reports SET status=$2,reviewer_id=$3,reviewed_at=now(),review_note=$4,updated_at=now() WHERE id=$1`,
        [reportId, dto.decision, user.sub, dto.note?.trim() ?? null]);
      await q(
        `INSERT INTO work_report_reviews (id,report_id,reviewer_id,decision,note) VALUES ($1,$2,$3,$4,$5)`,
        [newId(), reportId, user.sub, dto.decision, dto.note?.trim() ?? null]);
      await this.audit.recordWithinTx(q, {
        tenantId: user.tid, actorId: user.sub, action: 'work_report.reviewed',
        target: reportId, ip, correlationId,
        meta: { workerId: report.worker_id, decision: dto.decision },
      });
      return { id: reportId, status: dto.decision };
    });
  }

  async getReport(user: AuthUser, reportId: string) {
    const report = (await this.db.query(
      `SELECT r.*, s.started_at, s.ended_at, s.site_id FROM work_reports r
       JOIN attendance_sessions s ON s.id=r.session_id
       WHERE r.id=$1 AND r.tenant_id=$2`, [reportId, user.tid]))[0];
    if (!report) throw new NotFoundException();
    if (!(await this.inWorkerScope(user, report.worker_id))) throw new NotFoundException();
    const [activities, revisions, reviews] = await Promise.all([
      this.items(reportId),
      this.db.query(
        `SELECT revision,snapshot,created_by AS "createdBy",created_at AS "createdAt"
         FROM work_report_revisions WHERE report_id=$1 ORDER BY revision`, [reportId]),
      this.db.query(
        `SELECT reviewer_id AS "reviewerId",decision,note,created_at AS "createdAt"
         FROM work_report_reviews WHERE report_id=$1 ORDER BY created_at`, [reportId]),
    ]);
    return {
      id: report.id, sessionId: report.session_id, workerId: report.worker_id, status: report.status,
      submittedAt: report.submitted_at, reviewerId: report.reviewer_id, reviewedAt: report.reviewed_at,
      reviewNote: report.review_note, startedAt: report.started_at, endedAt: report.ended_at,
      activities, revisions, reviews,
    };
  }

  async listReports(user: AuthUser, date?: string, status?: string) {
    if (user.role === 'worker') {
      return this.queryReports(user, [user.sub], date, status);
    }
    if (user.role === 'supervisor') {
      const members = await this.roster.members(user);
      return this.queryReports(user, members.filter((m) => m.status === 'active' && m.role === 'worker').map((m) => m.id), date, status);
    }
    if (user.role === 'management' || user.role === 'admin') return this.queryReports(user, null, date, status);
    throw new ForbiddenException();
  }

  private async queryReports(user: AuthUser, workerIds: string[] | null, date?: string, status?: string) {
    const params: unknown[] = [user.tid];
    let where = 'r.tenant_id=$1';
    if (workerIds) {
      if (!workerIds.length) return [];
      params.push(workerIds);
      where += ` AND r.worker_id = ANY($${params.length})`;
    }
    if (date) {
      const [from, to] = this.dayRange(date);
      params.push(from, to);
      where += ` AND s.started_at >= $${params.length - 1} AND s.started_at < $${params.length}`;
    }
    if (status) {
      if (!['draft', 'submitted', 'acknowledged', 'clarification', 'rejected'].includes(status)) throw new BadRequestException('Unknown report status.');
      params.push(status);
      where += ` AND r.status=$${params.length}`;
    }
    return this.db.query(
      `SELECT r.id,r.session_id AS "sessionId",r.worker_id AS "workerId",r.status,r.submitted_at AS "submittedAt",
       r.review_note AS "reviewNote",s.started_at AS "startedAt",s.ended_at AS "endedAt",
       COALESCE(i.activity_count,0) AS "activityCount"
       FROM work_reports r JOIN attendance_sessions s ON s.id=r.session_id
       LEFT JOIN (SELECT report_id,count(*)::int AS activity_count FROM work_report_items GROUP BY report_id) i ON i.report_id=r.id
       WHERE ${where} ORDER BY s.started_at DESC LIMIT 500`, params);
  }

  private dayRange(day: string): [Date, Date] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
      throw new BadRequestException('Date must look like 2026-10-16.');
    }
    const start = Date.parse(`${day}T00:00:00Z`) - this.cfg.tzOffsetMinutes * 60_000;
    return [new Date(start), new Date(start + 86_400_000)];
  }

  private range(from?: string, to?: string) {
    const today = new Date(Date.now() + this.cfg.tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
    const endDay = to ?? today;
    const startDay = from ?? new Date(Date.parse(`${endDay}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
    const [start] = this.dayRange(startDay);
    const [, end] = this.dayRange(endDay);
    if (start >= end) throw new BadRequestException('The report start date must be before its end date.');
    if (end.getTime() - start.getTime() > 366 * 86_400_000) throw new BadRequestException('Report exports are limited to 366 days at a time.');
    return { startDay, endDay, start, end };
  }

  async insights(user: AuthUser, from?: string, to?: string) {
    if (user.role !== 'management' && user.role !== 'admin') throw new ForbiddenException();
    const range = this.range(from, to);
    const params = [user.tid, range.start, range.end];
    const [reports, activities, attendance, workers] = await Promise.all([
      this.db.query(
        `SELECT r.status,count(*)::int AS count FROM work_reports r JOIN attendance_sessions s ON s.id=r.session_id
         WHERE r.tenant_id=$1 AND s.started_at >= $2 AND s.started_at < $3 GROUP BY r.status ORDER BY r.status`, params),
      this.db.query(
        `SELECT i.activity_status AS status,COALESCE(i.unit,'unspecified') AS unit,
         count(*)::int AS count,sum(i.quantity) AS quantity
         FROM work_report_items i JOIN work_reports r ON r.id=i.report_id JOIN attendance_sessions s ON s.id=r.session_id
         WHERE r.tenant_id=$1 AND s.started_at >= $2 AND s.started_at < $3
         GROUP BY i.activity_status,COALESCE(i.unit,'unspecified') ORDER BY i.activity_status,unit`, params),
      this.db.query(
        `SELECT status,started_at,ended_at FROM attendance_sessions
         WHERE tenant_id=$1 AND started_at >= $2 AND started_at < $3`, params),
      this.roster.members(user),
    ]);
    const reportCounts = new Map(reports.map((r: any) => [r.status, r.count]));
    const workerIds = workers.filter((m) => m.role === 'worker').map((m) => m.id);
    const byDepartment: Record<string, { workers: number; reports: number }> = {};
    for (const member of workers) {
      if (member.role !== 'worker') continue;
      const departmentId = member.departmentId ?? 'unassigned';
      byDepartment[departmentId] ??= { workers: 0, reports: 0 };
      byDepartment[departmentId].workers++;
    }
    if (workerIds.length) {
      const counts = await this.db.query(
        `SELECT worker_id,count(*)::int AS count FROM work_reports r JOIN attendance_sessions s ON s.id=r.session_id
         WHERE r.tenant_id=$1 AND r.worker_id = ANY($2) AND s.started_at >= $3 AND s.started_at < $4 GROUP BY worker_id`,
        [user.tid, workerIds, range.start, range.end]);
      const departmentOf = new Map(workers.map((m) => [m.id, m.departmentId ?? 'unassigned']));
      for (const row of counts) {
        const key = departmentOf.get(row.worker_id) ?? 'unassigned';
        byDepartment[key] ??= { workers: 0, reports: 0 };
        byDepartment[key].reports += row.count;
      }
    }
    const attendanceSummary = attendance.reduce((sum: any, session: any) => {
      sum.total++;
      if (session.status === 'closed') {
        sum.closed++;
        if (session.ended_at) sum.minutes += Math.max(0, Math.round((new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 60_000));
      } else if (session.status === 'open') sum.open++;
      return sum;
    }, { total: 0, closed: 0, open: 0, minutes: 0 });
    return {
      from: range.startDay, to: range.endDay,
      reports: {
        total: [...reportCounts.values()].reduce((sum: number, count: any) => sum + Number(count), 0),
        byStatus: reports,
      },
      activities,
      attendance: attendanceSummary,
      departments: Object.entries(byDepartment).map(([departmentId, data]) => ({ departmentId, ...data })),
    };
  }

  async exportCsv(user: AuthUser, from?: string, to?: string) {
    if (user.role !== 'management' && user.role !== 'admin') throw new ForbiddenException();
    const range = this.range(from, to);
    const rows = await this.db.query(
      `SELECT r.id AS report_id,r.status AS report_status,s.started_at,s.ended_at,
       r.worker_id,i.description,i.activity_status,i.quantity,i.unit,i.challenge,i.notes,i.task_id,t.title AS task_title
       FROM work_reports r JOIN attendance_sessions s ON s.id=r.session_id
       LEFT JOIN work_report_items i ON i.report_id=r.id
       LEFT JOIN work_tasks t ON t.id=i.task_id
       WHERE r.tenant_id=$1 AND s.started_at >= $2 AND s.started_at < $3
       ORDER BY s.started_at,r.worker_id,i.position,i.created_at LIMIT 100001`,
      [user.tid, range.start, range.end]);
    if (rows.length > 100000) throw new BadRequestException('The export is too large. Narrow the date range and try again.');
    const members = await this.roster.members(user);
    const byId = new Map<string, Member>(members.map((m) => [m.id, m]));
    const cell = (value: unknown) => {
      let text = value == null ? '' : String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const header = ['Report ID', 'Date', 'Clock in', 'Clock out', 'Worker ID', 'Staff number', 'Worker name',
      'Department ID', 'Report status', 'Activity', 'Activity status', 'Quantity', 'Unit', 'Challenge', 'Notes', 'Task ID', 'Task title'];
    const lines = [header.map(cell).join(',')];
    for (const row of rows) {
      const worker = byId.get(row.worker_id);
      lines.push([
        row.report_id, row.started_at, row.started_at, row.ended_at, row.worker_id,
        worker?.staffNumber, worker?.fullName, worker?.departmentId, row.report_status,
        row.description, row.activity_status, row.quantity, row.unit, row.challenge, row.notes, row.task_id, row.task_title,
      ].map(cell).join(','));
    }
    return { from: range.startDay, to: range.endDay, csv: `${lines.join('\r\n')}\r\n` };
  }
}
