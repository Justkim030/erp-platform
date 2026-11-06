import Link from 'next/link';
import type { SessionUser } from '@/lib/identity';
import { svc } from '@/lib/session';
import { dateOf, duration, timeOf, todayLocal } from '@/lib/labels';
import { ClockCard } from './ClockCard';
import { ReviewList } from './ReviewList';

const Chip = ({ k = 'ok', children }: { k?: 'ok' | 'wn' | 'bd'; children: React.ReactNode }) => <span className={`chip ${k}`}>{children}</span>;
const Row = ({ a, b, c }: { a: string; b?: string; c?: React.ReactNode }) => (<div className="li"><span>{a}{b && <small>{b}</small>}</span>{c}</div>);
const Unavailable = () => <p className="notice" role="alert">Attendance data is unavailable right now. Please try again shortly.</p>;

function greeting() {
  const h = Number(new Date().toLocaleTimeString('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', hourCycle: 'h23' }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
const first = (u: SessionUser) => u.fullName.split(' ')[0];
const todayLabel = () => new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Nairobi', weekday: 'long', day: 'numeric', month: 'long' });

export const statusChip = (e: { outcome: string; reviewDecision?: string | null; isLate?: boolean } | null) =>
  !e ? null : e.reviewDecision === 'declined' ? <Chip k="bd">Declined</Chip>
  : e.outcome === 'review' && !e.reviewDecision ? <Chip k="wn">Pending review</Chip>
  : e.isLate ? <Chip k="wn">Late</Chip> : <Chip>On time</Chip>;

export async function WorkerHome({ user }: { user: SessionUser }) {
  const [st, hist] = await Promise.all([svc('attendance', '/v1/attendance/state'), svc<any[]>('attendance', '/v1/attendance/history?days=2')]);
  const today = hist?.find((s) => dateOf(s.clockIn.at) === dateOf(new Date().toISOString()));
  return (
    <div className="stack">
      <div><p className="eb">{todayLabel()}</p><h1 className="h">{greeting()}, {first(user)}</h1></div>
      {st ? <ClockCard state={st.state} since={st.since} sites={st.sites} siteId={st.siteId} /> : <Unavailable />}
      <div className="card"><b>Today</b>
        {today ? (<>
          <Row a="Clocked in" b={today.siteName} c={<span>{timeOf(today.clockIn.at)} {statusChip(today.clockIn)}</span>} />
          <Row a="Clocked out" c={today.clockOut ? <span>{timeOf(today.clockOut.at)} {statusChip(today.clockOut)}</span> : <span className="sub">Not yet</span>} />
          {today.minutes != null && <Row a="Time worked" c={<b>{duration(today.minutes)}</b>} />}
        </>) : <p className="sub">Nothing recorded yet today.</p>}
      </div>
    </div>
  );
}

const STATUS = { present: ['On time', 'ok'], late: ['Late', 'wn'], absent: ['Absent', 'bd'], clocked_out: ['Clocked out', 'ok'] } as const;

export async function SupervisorHome({ user }: { user: SessionUser }) {
  const [board, reviews] = await Promise.all([svc<any>('attendance', '/v1/team/attendance'), svc<any[]>('attendance', '/v1/team/reviews')]);
  return (
    <div className="stack">
      <div><p className="eb">Team overview · {todayLabel()}</p><h1 className="h">{greeting()}, {first(user)}</h1></div>
      <div className="actions">
        <Link className="btn sm" href="/team/new">Add employee</Link>
        <Link className="btn sm alt" href="/team">My team</Link>
        <Link className="btn sm alt" href="/map">View locations on map</Link>
      </div>
      {!board ? <Unavailable /> : (<>
        <div className="k">{[['Present', `${board.summary.present} of ${board.summary.total}`], ['Late', board.summary.late], ['Absent', board.summary.absent], ['To review', board.summary.review]].map(([a, b]) => (<div className="card" key={String(a)}><p className="sub">{a}</p><div className="num">{b}</div></div>))}</div>
        <div className="grid2">
          <div className="card"><b>Live team status</b>
            {board.members.length === 0 && <p className="sub">No active team members yet. Add an employee to get started.</p>}
            {board.members.map((m: any) => {
              const [label, k] = STATUS[m.status as keyof typeof STATUS];
              return <Row key={m.userId} a={m.fullName} b={m.clockIn ? `Clock-in ${m.clockIn.time}${m.clockOut ? ` · out ${m.clockOut.time}` : ''}` : 'Not clocked in'} c={<Chip k={k as any}>{label}</Chip>} />;
            })}
          </div>
          <div className="card"><b>Awaiting your decision</b><ReviewList items={reviews ?? []} /></div>
        </div>
      </>)}
    </div>
  );
}

export async function ManagementHome({ user }: { user: SessionUser }) {
  const [board, reviews, sites] = await Promise.all([svc<any>('attendance', '/v1/team/attendance'), svc<any[]>('attendance', '/v1/team/reviews'), svc<any[]>('attendance', '/v1/sites')]);
  const on = board ? board.members.filter((m: any) => m.status === 'present' || m.status === 'late').length : 0;
  const pct = board && board.summary.total ? Math.round((board.summary.present / board.summary.total) * 100) : 0;
  return (
    <div className="stack">
      <div><p className="eb">{todayLabel()}</p><h1 className="h">Operational overview</h1></div>
      <div className="actions">
        <Link className="btn sm" href="/team/new">Add employee</Link>
        <Link className="btn sm alt" href="/team">Team</Link>
        <Link className="btn sm alt" href="/map">Locations map</Link>
        <Link className="btn sm alt" href="/sites">Sites and rules</Link>
      </div>
      {!board ? <Unavailable /> : (<>
        <div className="k">{[['Attendance', `${pct}%`], ['On site now', on], ['Late arrivals', board.summary.late], ['To review', board.summary.review]].map(([a, b]) => (<div className="card" key={String(a)}><p className="sub">{a}</p><div className="num">{b}</div></div>))}</div>
        <div className="grid2">
          <div className="card"><b>Exceptions requiring review</b><ReviewList items={reviews ?? []} /></div>
          <div className="card"><b>Sites</b>
            {(sites ?? []).length === 0 && <p className="sub">No site yet. <Link href="/sites">Set up your first site</Link> so people can clock in.</p>}
            {(sites ?? []).map((s: any) => <Row key={s.id} a={s.name} b={`${s.radiusM} m radius · shift ${s.shiftStart}`} c={s.requireNetwork ? <Chip>Network required</Chip> : undefined} />)}
          </div>
        </div>
      </>)}
    </div>
  );
}
