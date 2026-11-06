import Link from 'next/link';
import { statusChip } from '@/components/Homes';
import { dateOf, duration, shiftDay, timeOf, todayLocal } from '@/lib/labels';
import { requireUser, svc } from '@/lib/session';

export default async function HistoryPage({ searchParams }: { searchParams: { date?: string } }) {
  const user = await requireUser();

  if (user.role === 'worker') {
    const sessions = await svc<any[]>('attendance', '/v1/attendance/history?days=31');
    const late = sessions?.filter((s) => s.clockIn.isLate).length ?? 0;
    const open = sessions?.filter((s) => s.clockIn.outcome === 'review' && !s.clockIn.reviewDecision).length ?? 0;
    return (
      <div className="stack">
        <div><p className="eb">Last 31 days</p><h1 className="h">Attendance history</h1></div>
        {!sessions ? <p className="notice">History is unavailable right now.</p> : (<>
          <div className="stats">{[[sessions.length, 'Days worked'], [late, 'Late arrivals'], [open, 'Pending review']].map(([a, b]) => (<div key={String(b)}><b>{a}</b><span>{b}</span></div>))}</div>
          <div className="card">
            {sessions.length === 0 && <p className="sub">No attendance recorded yet.</p>}
            {sessions.map((s) => (
              <div className="li" key={s.clockIn.id} style={{ alignItems: 'flex-start' }}>
                <span>{dateOf(s.clockIn.at)}<small>{timeOf(s.clockIn.at)} – {s.clockOut ? timeOf(s.clockOut.at) : 'no clock-out yet'}{s.minutes != null ? ` · ${duration(s.minutes)}` : ''}</small>{s.clockOut?.workSummary && <small>Work done: {s.clockOut.workSummary}</small>}</span>
                {statusChip(s.clockIn)}
              </div>
            ))}
          </div>
        </>)}
      </div>
    );
  }

  const day = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date ?? '') ? searchParams.date! : todayLocal();
  const board = await svc<any>('attendance', `/v1/team/attendance?date=${day}`);
  return (
    <div className="stack">
      <div><p className="eb">Team history and work reports</p><h1 className="h">{dateOf(`${day}T12:00:00+03:00`)}</h1></div>
      <div className="daynav"><Link href={`/history?date=${shiftDay(day, -1)}`}>← Previous day</Link>{day < todayLocal() && <Link href={`/history?date=${shiftDay(day, 1)}`}>Next day →</Link>}</div>
      {!board ? <p className="notice">History is unavailable right now.</p> : (
        <div className="card">
          <b>{board.summary.present} of {board.summary.total} present · {board.summary.late} late · {board.summary.absent} absent</b>
          {board.members.map((m: any) => (
            <div className="li" key={m.userId} style={{ alignItems: 'flex-start' }}>
              <span>{m.fullName}<small>{m.clockIn ? `In ${m.clockIn.time}` : 'No clock-in'}{m.clockOut ? ` · Out ${m.clockOut.time}` : ''}</small>{m.clockOut?.workSummary && <small>Work done: {m.clockOut.workSummary}</small>}</span>
              {m.clockIn ? statusChip(m.clockIn) : <span className="chip bd">Absent</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
