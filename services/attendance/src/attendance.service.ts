import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from './auth';
import { AppConfig, CONFIG } from './config';
import { Db, Q } from './db';
import { ClockInDto, ClockOutDto, ReviewDto, SiteDto } from './dto';
import { AuditService, Member, Roster, newId } from './support';
import { SiteRow, clockTime, evaluate, isLate, workerMessage } from './verification';

type Ctx = { ip?: string; ua?: string };
// An event counts toward attendance unless it was declined, or a supervisor declined it on review.
const EFFECTIVE = `outcome <> 'declined' AND (review_decision IS NULL OR review_decision <> 'declined')`;
const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(',');

@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly roster: Roster,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  // ---------- sites
  private siteOut(s: any, full: boolean) {
    if (!full) return { id: s.id, name: s.name };
    return {
      id: s.id, name: s.name, lat: s.lat, lng: s.lng, radiusM: s.radius_m, accuracyLimitM: s.accuracy_limit_m, timezone: s.timezone,
      shiftStart: s.shift_start, graceMinutes: s.grace_minutes, allowedIps: JSON.parse(s.allowed_ips || '[]'), requireNetwork: s.require_network,
    };
  }
  async listSites(user: AuthUser) {
    const rows = await this.db.query('SELECT * FROM sites WHERE tenant_id=$1 AND active=true ORDER BY created_at', [user.tid]);
    return rows.map((s) => this.siteOut(s, user.role !== 'worker'));
  }
  async saveSite(user: AuthUser, dto: SiteDto, id: string | undefined, ip?: string) {
    const tz = dto.timezone ?? 'Africa/Nairobi';
    try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); } catch { throw new BadRequestException('Unknown time zone.'); }
    const vals = [dto.name, dto.lat, dto.lng, dto.radiusM, dto.accuracyLimitM ?? 100, tz, dto.shiftStart ?? '08:00', dto.graceMinutes ?? 10, JSON.stringify(dto.allowedIps ?? []), dto.requireNetwork ?? false];
    let siteId = id;
    if (id) {
      const r = await this.db.query(
        `UPDATE sites SET name=$3, lat=$4, lng=$5, radius_m=$6, accuracy_limit_m=$7, timezone=$8, shift_start=$9, grace_minutes=$10, allowed_ips=$11, require_network=$12 WHERE id=$1 AND tenant_id=$2 RETURNING id`,
        [id, user.tid, ...vals]);
      if (!r.length) throw new NotFoundException();
    } else {
      siteId = newId();
      await this.db.query(
        `INSERT INTO sites (id,tenant_id,name,lat,lng,radius_m,accuracy_limit_m,timezone,shift_start,grace_minutes,allowed_ips,require_network) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [siteId, user.tid, ...vals]);
    }
    await this.audit.record({ tenantId: user.tid, actorId: user.sub, action: id ? 'site.updated' : 'site.created', target: dto.name, ip });
    return this.siteOut((await this.db.query('SELECT * FROM sites WHERE id=$1', [siteId]))[0], true);
  }
  private async pickSite(tid: string, siteId?: string): Promise<SiteRow> {
    const rows = siteId
      ? await this.db.query('SELECT * FROM sites WHERE id=$1 AND tenant_id=$2 AND active=true', [siteId, tid])
      : await this.db.query('SELECT * FROM sites WHERE tenant_id=$1 AND active=true ORDER BY created_at LIMIT 1', [tid]);
    if (!rows[0]) throw new NotFoundException(siteId ? 'Site not found.' : 'No site has been set up yet. Ask your manager.');
    return rows[0];
  }
  /** Same as pickSite but inside the caller's transaction. */
  private async pickSiteTx(q: Q, tid: string, siteId?: string): Promise<SiteRow> {
    const rows = siteId
      ? await q('SELECT * FROM sites WHERE id=$1 AND tenant_id=$2 AND active=true', [siteId, tid])
      : await q('SELECT * FROM sites WHERE tenant_id=$1 AND active=true ORDER BY created_at LIMIT 1', [tid]);
    if (!rows[0]) throw new NotFoundException(siteId ? 'Site not found.' : 'No site has been set up yet. Ask your manager.');
    return rows[0];
  }

  // ---------- worker
  private async lastEffective(tid: string, uid: string) {
    return (await this.db.query(`SELECT * FROM attendance_events WHERE tenant_id=$1 AND user_id=$2 AND ${EFFECTIVE} ORDER BY occurred_at DESC LIMIT 1`, [tid, uid]))[0];
  }
  async state(user: AuthUser) {
    const e = await this.lastEffective(user.tid, user.sub);
    const open = e?.kind === 'in';
    return {
      state: open ? 'in' : 'out', since: open ? e.occurred_at : null, siteId: open ? e.site_id : null,
      lastEvent: e ? { kind: e.kind, at: e.occurred_at, outcome: e.outcome } : null,
      sites: await this.listSites(user),
    };
  }

  async clock(kind: 'in' | 'out', user: AuthUser, dto: ClockInDto | ClockOutDto, ctx: Ctx & { correlationId?: string }) {
    // Everything below runs inside ONE transaction guarded by a per-user advisory lock.
    // The lock serialises the check-then-insert for the same worker, so two concurrent
    // clock-ins cannot both pass the state check. The insert and its audit row commit
    // together: a failed write leaves no partial state.
    return this.db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${user.tid}:${user.sub}`]);
      const prev = (await q(`SELECT * FROM attendance_events WHERE tenant_id=$1 AND user_id=$2 AND ${EFFECTIVE} ORDER BY occurred_at DESC LIMIT 1`, [user.tid, user.sub]))[0];
      if (kind === 'in' && prev?.kind === 'in') throw new ConflictException('You are already clocked in.');
      if (kind === 'out' && prev?.kind !== 'in') throw new ConflictException('You are not clocked in.');
      const site = await this.pickSiteTx(q, user.tid, dto.siteId ?? (kind === 'out' ? prev.site_id : undefined));
      const now = new Date();
      const recent = await q(
        `SELECT lat, lng, occurred_at FROM attendance_events WHERE tenant_id=$1 AND user_id=$2 AND lat IS NOT NULL AND ${EFFECTIVE} ORDER BY occurred_at DESC LIMIT 3`,
        [user.tid, user.sub]);
      let verdict = evaluate(site, dto.reading ?? {}, { ip: ctx.ip, now, prev: recent[0] ?? null, recent });
      // Fail safe for people: a declined worker can ask for human review instead of being stuck.
      if (verdict.outcome === 'declined' && dto.requestReview) verdict = { ...verdict, outcome: 'review', reasons: [...verdict.reasons, 'review_requested'] };
      const late = kind === 'in' && verdict.outcome !== 'declined' && isLate(site, now);
      const id = newId();
      const r = dto.reading;
      await q(
        `INSERT INTO attendance_events (id,tenant_id,user_id,site_id,kind,occurred_at,lat,lng,accuracy_m,distance_m,outcome,reasons,is_late,work_summary,ip,user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [id, user.tid, user.sub, site.id, kind, now, r?.lat ?? null, r?.lng ?? null, r?.accuracy ?? null, verdict.distanceM, verdict.outcome,
          JSON.stringify(verdict.reasons), late, 'workSummary' in dto ? (dto as ClockOutDto).workSummary.trim() : null, ctx.ip ?? null, ctx.ua?.slice(0, 300) ?? null]);
      // Critical action: the audit row commits or rolls back with the event itself.
      await this.audit.recordWithinTx(q, {
        tenantId: user.tid, actorId: user.sub, action: kind === 'in' ? 'attendance.clock_in' : 'attendance.clock_out', target: id,
        ip: ctx.ip, ua: ctx.ua, correlationId: ctx.correlationId,
        meta: { outcome: verdict.outcome, reasons: verdict.reasons, isLate: late, siteId: site.id, distanceM: verdict.distanceM },
      });
      // The worker sees the result and what to do next, not which internal checks fired.
      return { id, kind, outcome: verdict.outcome, isLate: late, at: now, siteName: site.name, message: workerMessage(kind, verdict, site, now) };
    });
  }

  /** Worker's own sessions. Paginated with `page` (envelope), bounded legacy call without it. */
  async history(user: AuthUser, days: number, page?: number, pageSize = 50) {
    const from = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db.query(
      `SELECT e.*, s.name AS site_name, s.timezone FROM attendance_events e JOIN sites s ON s.id=e.site_id
       WHERE e.tenant_id=$1 AND e.user_id=$2 AND e.occurred_at >= $3 AND e.outcome <> 'declined' AND (e.review_decision IS NULL OR e.review_decision <> 'declined') ORDER BY e.occurred_at`,
      [user.tid, user.sub, from]);
    const sessions: any[] = [];
    let open: any = null;
    const shape = (e: any) => ({ id: e.id, at: e.occurred_at, outcome: e.outcome, reviewDecision: e.review_decision, isLate: e.is_late, workSummary: e.work_summary });
    const push = (i: any, o: any) => sessions.push({
      siteName: i.site_name, clockIn: shape(i), clockOut: o ? shape(o) : null,
      minutes: o ? Math.round((new Date(o.occurred_at).getTime() - new Date(i.occurred_at).getTime()) / 60_000) : null,
    });
    for (const e of rows) {
      if (e.kind === 'in') { if (open) push(open, null); open = e; }
      else if (open) { push(open, e); open = null; }
    }
    if (open) push(open, null);
    // Events arrive oldest-first, so `sessions` is oldest-first; reverse for newest-first display.
    sessions.reverse();
    const capped = Math.min(Math.max(pageSize, 1), 100);
    if (page === undefined) return sessions.slice(0, capped); // backward compatible, now bounded
    const p = Math.max(page, 1);
    return { items: sessions.slice((p - 1) * capped, p * capped), page: p, pageSize: capped, total: sessions.length };
  }

  // ---------- supervisor and management
  private today() { return new Date(Date.now() + this.cfg.tzOffsetMinutes * 60_000).toISOString().slice(0, 10); }
  private dayRange(day: string): [Date, Date] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw new BadRequestException('Date must look like 2026-10-16.');
    const start = Date.parse(`${day}T00:00:00Z`) - this.cfg.tzOffsetMinutes * 60_000;
    return [new Date(start), new Date(start + 86_400_000)];
  }
  private async teamEvents(user: AuthUser, from: Date, to: Date, extra = '') {
    const members = (await this.roster.members(user)).filter((m) => m.status === 'active');
    if (!members.length) return { members, events: [] as any[] };
    const ids = members.map((m) => m.id);
    const events = await this.db.query(
      `SELECT * FROM attendance_events WHERE tenant_id=$1 AND occurred_at >= $2 AND occurred_at < $3 AND user_id IN (${marks(ids.length, 4)}) ${extra} ORDER BY occurred_at`,
      [user.tid, from, to, ...ids]);
    return { members, events };
  }
  private pub(e: any) {
    return {
      id: e.id, kind: e.kind, at: e.occurred_at, outcome: e.outcome, reasons: JSON.parse(e.reasons), isLate: e.is_late, workSummary: e.work_summary,
      distanceM: e.distance_m, accuracyM: e.accuracy_m, siteId: e.site_id, reviewDecision: e.review_decision, reviewNote: e.review_note,
    };
  }

  async board(user: AuthUser, date?: string) {
    const day = date ?? this.today();
    const [from, to] = this.dayRange(day);
    const { members, events } = await this.teamEvents(user, from, to);
    const sites = new Map((await this.db.query('SELECT id, timezone FROM sites WHERE tenant_id=$1', [user.tid])).map((s) => [s.id, s.timezone]));
    const rows = members.map((m: Member) => {
      const mine = events.filter((e) => e.user_id === m.id);
      const valid = mine.filter((e) => e.outcome !== 'declined' && e.review_decision !== 'declined');
      const cin = valid.find((e) => e.kind === 'in');
      const cout = [...valid].reverse().find((e) => e.kind === 'out' && (!cin || e.occurred_at >= cin.occurred_at));
      const needsReview = mine.some((e) => e.outcome === 'review' && !e.review_decision);
      const status = !cin ? 'absent' : cout ? 'clocked_out' : cin.is_late ? 'late' : 'present';
      return {
        userId: m.id, staffNumber: m.staffNumber, fullName: m.fullName, role: m.role, status, needsReview,
        clockIn: cin ? { ...this.pub(cin), time: clockTime(sites.get(cin.site_id) ?? 'Africa/Nairobi', new Date(cin.occurred_at)) } : null,
        clockOut: cout ? { ...this.pub(cout), time: clockTime(sites.get(cout.site_id) ?? 'Africa/Nairobi', new Date(cout.occurred_at)) } : null,
      };
    });
    const present = rows.filter((r) => r.status !== 'absent');
    return {
      date: day,
      summary: { total: rows.length, present: present.length, late: rows.filter((r) => r.status === 'late' || (r.clockIn?.isLate ?? false)).length, absent: rows.length - present.length, review: rows.filter((r) => r.needsReview).length },
      members: rows,
    };
  }

  /** Pinpoints every clock-in and clock-out of the caller's team on a day. Viewing is itself audited. */
  async map(user: AuthUser, ip: string | undefined, date?: string) {
    const day = date ?? this.today();
    const [from, to] = this.dayRange(day);
    const { members, events } = await this.teamEvents(user, from, to, 'AND lat IS NOT NULL');
    const by = new Map(members.map((m) => [m.id, m]));
    const sites = (await this.db.query('SELECT * FROM sites WHERE tenant_id=$1 AND active=true', [user.tid])).map((s) => this.siteOut(s, true));
    await this.audit.record({ tenantId: user.tid, actorId: user.sub, action: 'location.viewed', ip, meta: { date: day, points: events.length } });
    return {
      date: day, sites,
      points: events.map((e) => ({ ...this.pub(e), lat: e.lat, lng: e.lng, userId: e.user_id, staffNumber: by.get(e.user_id)?.staffNumber, fullName: by.get(e.user_id)?.fullName })),
    };
  }

  async reviews(user: AuthUser, page?: number, pageSize = 50) {
    const { members, events } = await this.teamEvents(user, new Date(Date.now() - 14 * 86_400_000), new Date(Date.now() + 86_400_000), `AND outcome='review' AND review_decision IS NULL`);
    const by = new Map(members.map((m) => [m.id, m]));
    const all = events.reverse().map((e) => ({ ...this.pub(e), userId: e.user_id, staffNumber: by.get(e.user_id)?.staffNumber, fullName: by.get(e.user_id)?.fullName }));
    const capped = Math.min(Math.max(pageSize, 1), 200);
    if (page === undefined) return all.slice(0, capped); // bounded legacy shape
    const p = Math.max(page, 1);
    return { items: all.slice((p - 1) * capped, p * capped), page: p, pageSize: capped, total: all.length };
  }

  async review(user: AuthUser, id: string, dto: ReviewDto, ip?: string, correlationId?: string) {
    // Review decision and its audit record commit together: an approved/declined
    // entry must never exist without its audit trail.
    return this.db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`review:${id}`]);
      const e = (await q('SELECT * FROM attendance_events WHERE id=$1 AND tenant_id=$2', [id, user.tid]))[0];
      const members = e ? await this.roster.members(user) : [];
      if (!e || !members.some((m) => m.id === e.user_id)) throw new NotFoundException();
      if (e.outcome !== 'review' || e.review_decision) throw new ConflictException('This entry is not waiting for review.');
      await q('UPDATE attendance_events SET review_decision=$2, review_note=$3, reviewed_by=$4, reviewed_at=$5 WHERE id=$1', [id, dto.decision, dto.note ?? null, user.sub, new Date()]);
      await this.audit.recordWithinTx(q, {
        tenantId: user.tid, actorId: user.sub, action: 'event.reviewed', target: id, ip, correlationId,
        meta: { decision: dto.decision, workerId: e.user_id, previousDecision: e.review_decision ?? null },
      });
      return { id, decision: dto.decision };
    });
  }
}
