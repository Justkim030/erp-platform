import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { AuthUser } from './auth';
import { AppConfig, CONFIG } from './config';
import { Db, Q } from './db';
import { ClockInDto, ClockOutDto, CreateExceptionDto, OverrideExceptionDto, PhysicalVerificationDto, ReviewDto, ReviewExceptionDto, SiteDto } from './dto';
import { AuditService, Member, Roster, dayRangeInTz, newId, todayInTz } from './support';
import { ClockPasskeyVerifier } from './passkeys';
import { SiteRow, clockTime, evaluate, isLate, workerMessage } from './verification';

type Ctx = { ip?: string; ua?: string };
// An event counts toward attendance unless it was declined, or a supervisor declined it on review.
const EFFECTIVE = `outcome <> 'declined' AND (review_decision IS NULL OR review_decision <> 'declined')`;
const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(',');

@Injectable()
export class AttendanceService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly roster: Roster,
    private readonly passkeys: ClockPasskeyVerifier,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  async onModuleInit() {
    await this.db.ensureReady();
    const state = (await this.db.query(`SELECT completed_at FROM attendance_session_backfill WHERE id='legacy'`))[0];
    if (state?.completed_at) return;
    await this.db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['attendance-session-backfill']);
      const current = (await q(`SELECT completed_at FROM attendance_session_backfill WHERE id='legacy'`))[0];
      if (current?.completed_at) return;
      const events = await q(
        `SELECT * FROM attendance_events WHERE outcome <> 'declined'
         AND (review_decision IS NULL OR review_decision <> 'declined')
         ORDER BY tenant_id, user_id, occurred_at, id`);
      let key = '';
      let open: { id: string; siteId: string; startedAt: Date } | null = null;
      for (const event of events) {
        const nextKey = `${event.tenant_id}:${event.user_id}`;
        if (nextKey !== key) { key = nextKey; open = null; }
        if (event.kind === 'in') {
          if (open) {
            await q(`UPDATE attendance_sessions SET status='needs_review', ended_at=$2 WHERE id=$1`, [open.id, event.occurred_at]);
          }
          const id = newId();
          await q(
            `INSERT INTO attendance_sessions (id,tenant_id,user_id,site_id,status,started_at,is_legacy) VALUES ($1,$2,$3,$4,'open',$5,true)`,
            [id, event.tenant_id, event.user_id, event.site_id, event.occurred_at]);
          await q('UPDATE attendance_events SET session_id=$2 WHERE id=$1', [event.id, id]);
          open = { id, siteId: event.site_id, startedAt: event.occurred_at };
        } else if (event.kind === 'out' && open) {
          await q('UPDATE attendance_events SET session_id=$2 WHERE id=$1', [event.id, open.id]);
          await q(`UPDATE attendance_sessions SET status='closed', ended_at=$2 WHERE id=$1`, [open.id, event.occurred_at]);
          open = null;
        }
      }
      await q(`UPDATE attendance_session_backfill SET completed_at=now() WHERE id='legacy'`);
    });
  }

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
    const [e, sessions] = await Promise.all([
      this.lastEffective(user.tid, user.sub),
      this.db.query(
        `SELECT id,site_id,started_at FROM attendance_sessions
         WHERE tenant_id=$1 AND user_id=$2 AND status='open' ORDER BY started_at DESC LIMIT 1`,
        [user.tid, user.sub]),
    ]);
    const session = sessions[0];
    const sessionEvent = session
      ? (await this.db.query(
        `SELECT * FROM attendance_events WHERE session_id=$1 AND kind='in' AND ${EFFECTIVE} ORDER BY occurred_at DESC LIMIT 1`,
        [session.id]))[0]
      : null;
    const open = !!session || e?.kind === 'in';
    const current = session ? sessionEvent : e;
    return {
      state: open ? 'in' : 'out',
      since: session?.started_at ?? (e?.kind === 'in' ? e.occurred_at : null),
      siteId: session?.site_id ?? (e?.kind === 'in' ? e.site_id : null),
      sessionId: session?.id ?? (e?.kind === 'in' ? e.session_id ?? null : null),
      lastEvent: current ? { kind: current.kind, at: current.occurred_at, outcome: current.outcome } : null,
      sites: await this.listSites(user),
    };
  }

  async workerIssues(user: AuthUser) {
    if (user.role !== 'worker') throw new ForbiddenException();
    const rows = await this.db.query(
      `SELECT id,kind,occurred_at AS at,session_id AS "sessionId",outcome,review_decision AS "reviewDecision",reasons
       FROM attendance_events WHERE tenant_id=$1 AND user_id=$2 AND outcome IN ('review','declined')
       ORDER BY occurred_at DESC LIMIT 100`, [user.tid, user.sub]);
    return rows.map((row) => ({ ...row, reasons: JSON.parse(row.reasons) }));
  }

  async clock(kind: 'in' | 'out', user: AuthUser, dto: ClockInDto | ClockOutDto, ctx: Ctx & { correlationId?: string }) {
    // Everything below runs inside ONE transaction guarded by a per-user advisory lock.
    // The lock serialises the check-then-insert for the same worker, so two concurrent
    // clock-ins cannot both pass the state check. The insert and its audit row commit
    // together: a failed write leaves no partial state.
    return this.db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${user.tid}:${user.sub}`]);
      const prev = (await q(`SELECT * FROM attendance_events WHERE tenant_id=$1 AND user_id=$2 AND ${EFFECTIVE} ORDER BY occurred_at DESC LIMIT 1`, [user.tid, user.sub]))[0];
      const active = (await q(
        `SELECT id,site_id FROM attendance_sessions WHERE tenant_id=$1 AND user_id=$2 AND status='open' ORDER BY started_at DESC LIMIT 1`,
        [user.tid, user.sub]))[0];
      if (kind === 'in' && (prev?.kind === 'in' || active)) throw new ConflictException('You are already clocked in.');
      if (kind === 'out' && !active) {
        if (prev?.kind === 'in') throw new ConflictException('Your attendance session needs review. Ask a manager for help.');
        throw new ConflictException('You are not clocked in.');
      }
      const site = await this.pickSiteTx(q, user.tid, dto.siteId ?? (kind === 'out' ? active.site_id : undefined));
      const now = new Date();
      const recent = await q(
        `SELECT lat, lng, occurred_at FROM attendance_events WHERE tenant_id=$1 AND user_id=$2 AND lat IS NOT NULL AND ${EFFECTIVE} ORDER BY occurred_at DESC LIMIT 3`,
        [user.tid, user.sub]);
      let verdict = evaluate(site, dto.reading ?? {}, { ip: ctx.ip, now, prev: recent[0] ?? null, recent });
      // Fail safe for people: a declined worker can ask for human review instead of being stuck.
      if (verdict.outcome === 'declined' && dto.requestReview) verdict = { ...verdict, outcome: 'review', reasons: [...verdict.reasons, 'review_requested'] };
      const late = kind === 'in' && verdict.outcome !== 'declined' && isLate(site, now);
      if (kind === 'in' && user.role === 'worker') await this.passkeys.consume(user, dto.passkeyProof, ctx);
      const id = newId();
      let sessionId: string | null = null;
      let workSummary = 'workSummary' in dto ? (dto as ClockOutDto).workSummary?.trim() ?? '' : '';
      if (kind === 'in' && verdict.outcome !== 'declined') {
        sessionId = newId();
        await q(
          `INSERT INTO attendance_sessions (id,tenant_id,user_id,site_id,status,started_at) VALUES ($1,$2,$3,$4,'open',$5)`,
          [sessionId, user.tid, user.sub, site.id, now]);
      } else if (kind === 'out') {
        sessionId = active.id;
      }
      const r = dto.reading;
      await q(
        `INSERT INTO attendance_events (id,tenant_id,user_id,site_id,kind,occurred_at,lat,lng,accuracy_m,distance_m,outcome,reasons,is_late,work_summary,ip,user_agent,session_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, user.tid, user.sub, site.id, kind, now, r?.lat ?? null, r?.lng ?? null, r?.accuracy ?? null, verdict.distanceM, verdict.outcome,
          JSON.stringify(verdict.reasons), late, kind === 'out' ? workSummary : null, ctx.ip ?? null, ctx.ua?.slice(0, 300) ?? null, sessionId]);
      if (kind === 'out' && verdict.outcome !== 'declined') {
        await q(`UPDATE attendance_sessions SET status='closed', ended_at=$2 WHERE id=$1`, [sessionId, now]);
      }
      // Critical action: the audit row commits or rolls back with the event itself.
      await this.audit.recordWithinTx(q, {
        tenantId: user.tid, actorId: user.sub, action: kind === 'in' ? 'attendance.clock_in' : 'attendance.clock_out', target: id,
        ip: ctx.ip, ua: ctx.ua, correlationId: ctx.correlationId,
        meta: { outcome: verdict.outcome, reasons: verdict.reasons, isLate: late, siteId: site.id, distanceM: verdict.distanceM, sessionId },
      });
      // The worker sees the result and what to do next, not which internal checks fired.
      return { id, sessionId, kind, outcome: verdict.outcome, isLate: late, at: now, siteName: site.name, message: workerMessage(kind, verdict, site, now) };
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
    const shape = (e: any) => ({ id: e.id, sessionId: e.session_id ?? null, at: e.occurred_at, outcome: e.outcome, reviewDecision: e.review_decision, isLate: e.is_late, workSummary: e.work_summary });
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
  private today() { return todayInTz(this.cfg.timezone); }
  private dayRange(day: string): [Date, Date] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw new BadRequestException('Date must look like 2026-10-16.');
    return dayRangeInTz(this.cfg.timezone, day);
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
      id: e.id, sessionId: e.session_id ?? null, kind: e.kind, at: e.occurred_at, outcome: e.outcome, reasons: JSON.parse(e.reasons), isLate: e.is_late, workSummary: e.work_summary,
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
      if (e.session_id) {
        if (e.kind === 'out' && dto.decision === 'declined') {
          await q(`UPDATE attendance_sessions SET status='open', ended_at=NULL WHERE id=$1`, [e.session_id]);
        } else if (e.kind === 'out') {
          await q(`UPDATE attendance_sessions SET status='closed', ended_at=$2 WHERE id=$1`, [e.session_id, e.occurred_at]);
        } else if (dto.decision === 'declined') {
          await q(`UPDATE attendance_sessions SET status='void', ended_at=COALESCE(ended_at,$2) WHERE id=$1`, [e.session_id, e.occurred_at]);
        } else {
          const out = (await q(
            `SELECT occurred_at FROM attendance_events WHERE session_id=$1 AND kind='out' AND outcome <> 'declined'
             AND (review_decision IS NULL OR review_decision <> 'declined') ORDER BY occurred_at DESC LIMIT 1`, [e.session_id]))[0];
          if (out) await q(`UPDATE attendance_sessions SET status='closed', ended_at=$2 WHERE id=$1`, [e.session_id, out.occurred_at]);
          else {
            // Reopen the session only when the worker has not already started a newer
            // one: the one-open-session rule (partial unique index) must never be
            // violated, and the newer session is the authoritative one.
            const newer = (await q(
              `SELECT id FROM attendance_sessions WHERE tenant_id=$1 AND user_id=$2 AND status='open' AND id <> $3`,
              [user.tid, e.user_id, e.session_id]))[0];
            if (!newer) await q(`UPDATE attendance_sessions SET status='open', ended_at=NULL WHERE id=$1`, [e.session_id]);
          }
        }
      }
      await this.audit.recordWithinTx(q, {
        tenantId: user.tid, actorId: user.sub, action: 'event.reviewed', target: id, ip, correlationId,
        meta: { decision: dto.decision, workerId: e.user_id, previousDecision: e.review_decision ?? null },
      });
      return { id, decision: dto.decision };
    });
  }

  async createException(user: AuthUser, dto: CreateExceptionDto, ip?: string, correlationId?: string) {
    if (user.role !== 'worker') throw new ForbiddenException();
    const occurredAt = new Date(dto.occurredAt);
    if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('The reported time cannot be in the future.');

    let sessionId: string | null = null;
    let eventId: string | null = dto.eventId ?? null;
    let siteId: string | null = dto.siteId ?? null;
    if (dto.type === 'missed_clock_out') {
      if (!dto.workSummary?.trim()) throw new BadRequestException('Add a work summary for a missed clock-out.');
      const session = (await this.db.query(
        `SELECT * FROM attendance_sessions WHERE tenant_id=$1 AND user_id=$2 AND status='open'`,
        [user.tid, user.sub]))[0];
      if (!session || (dto.sessionId && dto.sessionId !== session.id)) throw new ConflictException('There is no matching open attendance session.');
      if (occurredAt < new Date(session.started_at)) throw new BadRequestException('The reported clock-out must be after the clock-in.');
      if (siteId && siteId !== session.site_id) throw new BadRequestException('A missed clock-out must use the session site.');
      sessionId = session.id;
      siteId = session.site_id;
    } else if (dto.type === 'missed_clock_in') {
      if (!siteId) throw new BadRequestException('Choose the site for the missed clock-in.');
      await this.pickSite(user.tid, siteId);
      if (dto.sessionId || dto.eventId) throw new BadRequestException('A missed clock-in cannot refer to an existing session or event.');
      const latest = await this.lastEffective(user.tid, user.sub);
      if (latest?.kind === 'in') throw new ConflictException('You already have an open attendance session.');
      const later = (await this.db.query(
        `SELECT id, kind FROM attendance_events WHERE tenant_id=$1 AND user_id=$2 AND occurred_at >= $3
         AND outcome <> 'declined' AND (review_decision IS NULL OR review_decision <> 'declined')
         ORDER BY occurred_at, id LIMIT 1`, [user.tid, user.sub, occurredAt]))[0];
      if (later?.kind === 'in') throw new ConflictException('A clock-in already exists at or after the reported time.');
    } else {
      if (!eventId && !dto.sessionId) throw new BadRequestException('Choose the attendance entry or session related to the issue.');
      if (eventId) {
        const event = (await this.db.query(
          `SELECT * FROM attendance_events WHERE id=$1 AND tenant_id=$2 AND user_id=$3`,
          [eventId, user.tid, user.sub]))[0];
        if (!event) throw new NotFoundException('Attendance entry not found.');
        if (dto.type === 'location_issue' && event.outcome !== 'review' && event.outcome !== 'declined') {
          throw new BadRequestException('Location issues can only be raised for flagged attendance entries.');
        }
        sessionId = event.session_id ?? null;
      }
      if (!sessionId && dto.sessionId) {
        const session = (await this.db.query(
          `SELECT id FROM attendance_sessions WHERE id=$1 AND tenant_id=$2 AND user_id=$3`,
          [dto.sessionId, user.tid, user.sub]))[0];
        if (!session) throw new NotFoundException('Attendance session not found.');
        sessionId = session.id;
      }
    }

    const id = newId();
    await this.db.tx(async (q) => {
      await q(
        `INSERT INTO attendance_exceptions (id,tenant_id,worker_id,session_id,event_id,exception_type,occurred_at,site_id,reason,work_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, user.tid, user.sub, sessionId, eventId, dto.type, occurredAt, siteId, dto.reason.trim(), dto.workSummary?.trim() ?? null]);
      await this.audit.recordWithinTx(q, {
        tenantId: user.tid, actorId: user.sub, action: 'attendance.exception_requested', target: id,
        ip, correlationId, meta: { type: dto.type, sessionId, eventId },
      });
    });
    return { id, type: dto.type, status: 'pending', sessionId, occurredAt };
  }

  async listExceptions(user: AuthUser, status?: string) {
    if (!['worker', 'supervisor', 'management', 'admin'].includes(user.role)) throw new ForbiddenException();
    let workerIds: string[] | null = null;
    if (user.role === 'worker') workerIds = [user.sub];
    else if (user.role === 'supervisor') {
      workerIds = (await this.roster.members(user)).filter((m) => m.status === 'active' && m.role === 'worker').map((m) => m.id);
    }
    if (workerIds && !workerIds.length) return [];
    if (status && !['pending', 'needs_info', 'approved', 'declined'].includes(status)) throw new BadRequestException('Unknown exception status.');
    const params: unknown[] = [user.tid];
    let where = 'tenant_id=$1';
    if (workerIds) {
      params.push(workerIds);
      where += ` AND worker_id = ANY($${params.length})`;
    }
    if (status) {
      params.push(status);
      where += ` AND status=$${params.length}`;
    }
    const rows = await this.db.query(
      `SELECT * FROM attendance_exceptions WHERE ${where} ORDER BY created_at DESC LIMIT 500`, params);
    return rows;
  }

  private async resolveException(
    user: AuthUser, id: string, decision: 'approved' | 'declined' | 'needs_info',
    note: string, ip?: string, correlationId?: string, override = false,
  ) {
    const before = (await this.db.query(
      `SELECT * FROM attendance_exceptions WHERE id=$1 AND tenant_id=$2`, [id, user.tid]))[0];
    if (!before) throw new NotFoundException();
    if (override) {
      if (user.role !== 'management' && user.role !== 'admin') throw new ForbiddenException();
    } else {
      if (user.role !== 'supervisor' && user.role !== 'management' && user.role !== 'admin') throw new ForbiddenException();
      if (user.role === 'supervisor') {
        const team = await this.roster.members(user);
        if (!team.some((m) => m.id === before.worker_id && m.role === 'worker' && m.status === 'active')) throw new NotFoundException();
      }
    }
    return this.db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`exception:${id}`]);
      const e = (await q(`SELECT * FROM attendance_exceptions WHERE id=$1 AND tenant_id=$2`, [id, user.tid]))[0];
      if (!e) throw new NotFoundException();
      if (e.status !== 'pending' && e.status !== 'needs_info') throw new ConflictException('This request has already been resolved.');
      if (decision === 'approved' && (e.exception_type === 'missed_clock_in' || e.exception_type === 'missed_clock_out')) {
        await this.applyExceptionCorrection(q, e, user, note);
      }
      const now = new Date();
      await q(
        `UPDATE attendance_exceptions SET status=$2, reviewer_id=$3, reviewed_at=$4, review_note=$5 WHERE id=$1`,
        [id, decision, user.sub, now, note || null]);
      await this.audit.recordWithinTx(q, {
        tenantId: user.tid, actorId: user.sub,
        action: override ? 'attendance.exception_overridden' : 'attendance.exception_reviewed',
        target: id, ip, correlationId,
        meta: { decision, workerId: e.worker_id, type: e.exception_type, override, reason: note },
      });
      return { id, status: decision };
    });
  }

  private async applyExceptionCorrection(q: Q, e: any, reviewer: AuthUser, note: string) {
    const occurredAt = new Date(e.occurred_at);
    if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('The reported time cannot be in the future.');
    if (e.exception_type === 'missed_clock_out') {
      const session = (await q(
        `SELECT * FROM attendance_sessions WHERE id=$1 AND tenant_id=$2 AND user_id=$3`,
        [e.session_id, reviewer.tid, e.worker_id]))[0];
      if (!session) throw new ConflictException('The attendance session is no longer available.');
      if (occurredAt < new Date(session.started_at)) throw new BadRequestException('The reported clock-out must be after the clock-in.');
      if (session.status !== 'open') {
        // The worker clocked out (or the session was resolved) after raising the request.
        // Refuse honestly instead of touching a session that is already closed.
        throw new ConflictException('The attendance session is no longer open.');
      }
      const eventId = newId();
      await q(
        `INSERT INTO attendance_events (id,tenant_id,user_id,site_id,kind,occurred_at,outcome,reasons,work_summary,reviewed_by,reviewed_at,review_decision,review_note,session_id)
         VALUES ($1,$2,$3,$4,'out',$5,'review',$6,$7,$8,$9,'approved',$10,$11)`,
        [eventId, reviewer.tid, e.worker_id, session.site_id, occurredAt, JSON.stringify(['manual_correction']), e.work_summary, reviewer.sub, new Date(), note, session.id]);
      await q(`UPDATE attendance_sessions SET status='closed', ended_at=$2 WHERE id=$1`, [session.id, occurredAt]);
      return;
    }
    const site = (await q('SELECT * FROM sites WHERE id=$1 AND tenant_id=$2 AND active=true', [e.site_id, reviewer.tid]))[0];
    if (!site) throw new ConflictException('The requested site is no longer available.');
    const later = (await q(
      `SELECT * FROM attendance_events WHERE tenant_id=$1 AND user_id=$2 AND occurred_at >= $3
       AND outcome <> 'declined' AND (review_decision IS NULL OR review_decision <> 'declined')
       ORDER BY occurred_at, id LIMIT 1`, [reviewer.tid, e.worker_id, occurredAt]))[0];
    if (later?.kind === 'in') throw new ConflictException('A clock-in already exists at or after the reported time.');
    const openSession = (await q(
      `SELECT id FROM attendance_sessions WHERE tenant_id=$1 AND user_id=$2 AND status='open'`,
      [reviewer.tid, e.worker_id]))[0];
    if (openSession) throw new ConflictException('The worker already has an open attendance session.');
    const sessionId = newId();
    const eventId = newId();
    const matchingOut = later?.kind === 'out' && !later.session_id ? later : null;
    await q(
      `INSERT INTO attendance_sessions (id,tenant_id,user_id,site_id,status,started_at,ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [sessionId, reviewer.tid, e.worker_id, site.id, matchingOut ? 'closed' : 'open', occurredAt, matchingOut?.occurred_at ?? null]);
    await q(
      `INSERT INTO attendance_events (id,tenant_id,user_id,site_id,kind,occurred_at,outcome,reasons,is_late,reviewed_by,reviewed_at,review_decision,review_note,session_id)
       VALUES ($1,$2,$3,$4,'in',$5,'review',$6,false,$7,$8,'approved',$9,$10)`,
      [eventId, reviewer.tid, e.worker_id, site.id, occurredAt, JSON.stringify(['manual_correction']), reviewer.sub, new Date(), note, sessionId]);
    if (matchingOut) await q('UPDATE attendance_events SET session_id=$2 WHERE id=$1', [matchingOut.id, sessionId]);
  }

  async reviewException(user: AuthUser, id: string, dto: ReviewExceptionDto, ip?: string, correlationId?: string) {
    return this.resolveException(user, id, dto.decision, dto.note ?? '', ip, correlationId);
  }

  async overrideException(user: AuthUser, id: string, dto: OverrideExceptionDto, ip?: string, correlationId?: string) {
    return this.resolveException(user, id, dto.decision, dto.reason, ip, correlationId, true);
  }

  async createPhysicalVerification(user: AuthUser, sessionId: string, dto: PhysicalVerificationDto, ip?: string, correlationId?: string) {
    if (user.role !== 'supervisor' && user.role !== 'management' && user.role !== 'admin') throw new ForbiddenException();
    if (!!dto.eventId === !!dto.exceptionId) throw new BadRequestException('Reference exactly one flagged attendance entry or exception.');
    const session = (await this.db.query(
      `SELECT * FROM attendance_sessions WHERE id=$1 AND tenant_id=$2`, [sessionId, user.tid]))[0];
    if (!session) throw new NotFoundException('Attendance session not found.');
    if (session.user_id === user.sub) throw new ForbiddenException('You cannot verify your own attendance.');
    if (user.role === 'supervisor') {
      const team = await this.roster.members(user);
      if (!team.some((m) => m.id === session.user_id && m.role === 'worker' && m.status === 'active')) throw new NotFoundException();
    }
    return this.db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`verification:${sessionId}`]);
      if (dto.eventId) {
        const event = (await q(
          `SELECT id FROM attendance_events WHERE id=$1 AND tenant_id=$2 AND user_id=$3 AND session_id=$4
           AND outcome IN ('review','declined')`,
          [dto.eventId, user.tid, session.user_id, sessionId]))[0];
        if (!event) throw new BadRequestException('The attendance entry is not a flagged issue in this session.');
      } else {
        const exception = (await q(
          `SELECT id FROM attendance_exceptions WHERE id=$1 AND tenant_id=$2 AND worker_id=$3 AND session_id=$4
           AND status IN ('pending','needs_info')`,
          [dto.exceptionId, user.tid, session.user_id, sessionId]))[0];
        if (!exception) throw new BadRequestException('The exception is not an open issue in this session.');
      }
      const id = newId();
      await q(
        `INSERT INTO physical_verifications (id,tenant_id,session_id,event_id,exception_id,worker_id,supervisor_id,outcome,note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, user.tid, sessionId, dto.eventId ?? null, dto.exceptionId ?? null, session.user_id, user.sub, dto.outcome, dto.note?.trim() ?? null]);
      await this.audit.recordWithinTx(q, {
        tenantId: user.tid, actorId: user.sub, action: 'attendance.physical_verification_recorded',
        target: id, ip, correlationId,
        meta: { sessionId, workerId: session.user_id, outcome: dto.outcome, eventId: dto.eventId ?? null, exceptionId: dto.exceptionId ?? null },
      });
      return { id, sessionId, workerId: session.user_id, outcome: dto.outcome, verifiedAt: new Date() };
    });
  }

  async createExceptionPhysicalVerification(user: AuthUser, exceptionId: string, dto: PhysicalVerificationDto, ip?: string, correlationId?: string) {
    if (user.role !== 'supervisor' && user.role !== 'management' && user.role !== 'admin') throw new ForbiddenException();
    const exception = (await this.db.query(
      `SELECT * FROM attendance_exceptions WHERE id=$1 AND tenant_id=$2 AND status IN ('pending','needs_info')`,
      [exceptionId, user.tid]))[0];
    if (!exception) throw new NotFoundException();
    if (exception.worker_id === user.sub) throw new ForbiddenException('You cannot verify your own attendance.');
    if (user.role === 'supervisor') {
      const team = await this.roster.members(user);
      if (!team.some((m) => m.id === exception.worker_id && m.role === 'worker' && m.status === 'active')) throw new NotFoundException();
    }
    if (exception.session_id) {
      return this.createPhysicalVerification(
        user, exception.session_id, { exceptionId, outcome: dto.outcome, note: dto.note }, ip, correlationId);
    }
    return this.db.tx(async (q) => {
      await q(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`verification:${exceptionId}`]);
      const current = (await q(
        `SELECT id,worker_id FROM attendance_exceptions WHERE id=$1 AND tenant_id=$2 AND status IN ('pending','needs_info')`,
        [exceptionId, user.tid]))[0];
      if (!current) throw new ConflictException('This issue is no longer open.');
      const id = newId();
      await q(
        `INSERT INTO physical_verifications (id,tenant_id,session_id,exception_id,worker_id,supervisor_id,outcome,note)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7)`,
        [id, user.tid, exceptionId, current.worker_id, user.sub, dto.outcome, dto.note?.trim() ?? null]);
      await this.audit.recordWithinTx(q, {
        tenantId: user.tid, actorId: user.sub, action: 'attendance.physical_verification_recorded',
        target: id, ip, correlationId,
        meta: { sessionId: null, workerId: current.worker_id, outcome: dto.outcome, exceptionId },
      });
      return { id, sessionId: null, workerId: current.worker_id, outcome: dto.outcome, verifiedAt: new Date() };
    });
  }

  async exceptionVerifications(user: AuthUser, exceptionId: string) {
    const exception = (await this.db.query(
      `SELECT worker_id FROM attendance_exceptions WHERE id=$1 AND tenant_id=$2`, [exceptionId, user.tid]))[0];
    if (!exception) throw new NotFoundException();
    if (user.role === 'worker' && exception.worker_id !== user.sub) throw new NotFoundException();
    if (user.role === 'supervisor' && !(await this.inSupervisorScope(user, exception.worker_id))) throw new NotFoundException();
    if (!['worker', 'supervisor', 'management', 'admin'].includes(user.role)) throw new ForbiddenException();
    return this.db.query(
      `SELECT id,session_id AS "sessionId",exception_id AS "exceptionId",worker_id AS "workerId",
       supervisor_id AS "supervisorId",verified_at AS "verifiedAt",outcome,method,note
       FROM physical_verifications WHERE tenant_id=$1 AND exception_id=$2 ORDER BY verified_at`, [user.tid, exceptionId]);
  }

  async physicalVerificationIssues(user: AuthUser) {
    if (user.role !== 'management' && user.role !== 'admin') throw new ForbiddenException();
    return this.db.query(
      `SELECT v.id,v.session_id AS "sessionId",v.exception_id AS "exceptionId",v.event_id AS "eventId",
       v.worker_id AS "workerId",v.supervisor_id AS "supervisorId",v.verified_at AS "verifiedAt",v.note,
       e.exception_type AS "exceptionType",e.reason
       FROM physical_verifications v LEFT JOIN attendance_exceptions e ON e.id=v.exception_id
       WHERE v.tenant_id=$1 AND v.outcome='not_found' ORDER BY v.verified_at DESC LIMIT 500`, [user.tid]);
  }

  async physicalVerifications(user: AuthUser, sessionId: string) {
    const session = (await this.db.query(
      `SELECT * FROM attendance_sessions WHERE id=$1 AND tenant_id=$2`, [sessionId, user.tid]))[0];
    if (!session) throw new NotFoundException();
    if (user.role === 'worker' && session.user_id !== user.sub) throw new NotFoundException();
    if (user.role === 'supervisor') {
      const team = await this.roster.members(user);
      if (session.user_id !== user.sub && !team.some((m) => m.id === session.user_id && m.role === 'worker' && m.status === 'active')) throw new NotFoundException();
    }
    return this.db.query(
      `SELECT id,session_id AS "sessionId",event_id AS "eventId",exception_id AS "exceptionId",worker_id AS "workerId",
       supervisor_id AS "supervisorId",verified_at AS "verifiedAt",outcome,method,note
       FROM physical_verifications WHERE tenant_id=$1 AND session_id=$2 ORDER BY verified_at`, [user.tid, sessionId]);
  }

  private async inSupervisorScope(user: AuthUser, workerId: string) {
    const team = await this.roster.members(user);
    return team.some((m) => m.id === workerId && m.role === 'worker' && m.status === 'active');
  }
}
