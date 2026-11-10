import Link from 'next/link';
import { ExceptionRequestForm } from '@/components/ExceptionRequestForm';
import { WorkReportEditor } from '@/components/WorkReportEditor';
import { todayLocal } from '@/lib/labels';
import { requireUser, svc } from '@/lib/session';

type Report = { id: string; sessionId: string; workerId: string; status: string; startedAt: string; activityCount: number };
type Session = { clockIn: { id: string; sessionId: string | null; at: string }; clockOut: { at: string } | null; siteName: string };

const label = (status: string) => status.replace('_', ' ');

export default async function ReportsPage({ searchParams }: { searchParams: { from?: string; to?: string } }) {
  const user = await requireUser();
  const reports = await svc<Report[]>('attendance', '/v1/work-reports');

  if (user.role === 'worker') {
    const [state, history, issues, tasks] = await Promise.all([
      svc<any>('attendance', '/v1/attendance/state'),
      svc<Session[]>('attendance', '/v1/attendance/history?days=31'),
      svc<any[]>('attendance', '/v1/attendance/issues'),
      svc<any[]>('attendance', '/v1/tasks'),
    ]);
    const candidates = (history ?? []).filter((s) => s.clockOut && s.clockIn.sessionId
      && !reports?.some((r) => r.sessionId === s.clockIn.sessionId && ['submitted', 'acknowledged'].includes(r.status)));
    const sessionId = state?.state === 'out' ? candidates[0]?.clockIn.sessionId : undefined;
    const report = sessionId ? reports?.find((r) => r.sessionId === sessionId) : undefined;
    const fullReport = report ? await svc<any>('attendance', `/v1/work-reports/${report.id}`) : null;
    return (
      <div className="stack">
        <div><p className="eb">End-of-shift activity outcomes</p><h1 className="h">Work reports</h1></div>
        {sessionId ? (
          <WorkReportEditor key={sessionId} sessionId={sessionId} initial={fullReport} tasks={tasks ?? []} />
        ) : state?.state === 'in'
          ? <p className="notice">Clock out when you leave, then submit your end-of-shift report here. No task is required to clock in.</p>
          : <p className="notice">No completed attendance session is waiting for a work report.</p>}
        {state && <ExceptionRequestForm state={state.state} sessionId={state.sessionId} sites={state.sites ?? []} issues={issues ?? []} />}
        <div className="card">
          <b>Submitted reports</b>
          {!reports?.length && <p className="sub">No work reports recorded yet.</p>}
          {(reports ?? []).map((r) => (
            <div className="li" key={r.id}>
              <span>{new Date(r.startedAt).toLocaleDateString()}<small>{r.activityCount} activities</small></span>
              <span className="actions"><span className="chip wn">{label(r.status)}</span><Link className="btn sm alt" href={`/reports/${r.id}`}>Open</Link></span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const date = searchParams.to ?? todayLocal();
  const teamReports = reports ?? [];
  const insights = user.role === 'management' || user.role === 'admin'
    ? await svc<any>('attendance', `/v1/management/insights?from=${encodeURIComponent(searchParams.from ?? date)}&to=${encodeURIComponent(date)}`)
    : null;
  return (
    <div className="stack">
      <div><p className="eb">{user.role === 'supervisor' ? 'Your assigned team' : 'Organisation-wide activity'}</p><h1 className="h">{user.role === 'supervisor' ? 'Team work reports' : 'Daily work reports'}</h1></div>
      {insights && (
        <div className="card stack">
          <b>Management insights</b>
          <form className="date-filter" method="get">
            <label>From <input type="date" name="from" defaultValue={searchParams.from ?? date} /></label>
            <label>To <input type="date" name="to" defaultValue={date} /></label>
            <button className="btn sm" type="submit">Update insights</button>
          </form>
          {insights ? (
            <>
              <div className="stats">
                <div><b>{insights.reports.total}</b><span>Reports</span></div>
                <div><b>{insights.attendance.total}</b><span>Attendance sessions</span></div>
                <div><b>{insights.attendance.closed}</b><span>Completed sessions</span></div>
              </div>
              <div className="li"><span>Activity outcomes by status and unit</span></div>
              {insights.activities.map((a: any) => <div className="li" key={`${a.status}-${a.unit}`}><span>{a.status}<small>{a.count} activities · {a.quantity ?? 0} {a.unit}</small></span></div>)}
              <a className="btn sm alt" href={`/api/svc/attendance/v1/management/reports/export.csv?from=${encodeURIComponent(searchParams.from ?? date)}&to=${encodeURIComponent(date)}`}>Download CSV</a>
            </>
          ) : <p className="notice">Management insights are unavailable right now.</p>}
        </div>
      )}
      {!insights && <p className="notice">Supervisors can review assigned-team reports. Organisation-wide insights and downloads are restricted to management.</p>}
      <div className="card">
        <b>{user.role === 'supervisor' ? 'Assigned-team reports' : 'Reports'}</b>
        {!teamReports.length && <p className="sub">No reports are available for this view.</p>}
        {teamReports.map((r) => (
          <div className="li" key={r.id}>
            <span>{r.workerId}<small>{new Date(r.startedAt).toLocaleDateString()} · {r.activityCount} activities</small></span>
            <span className="actions"><span className="chip wn">{label(r.status)}</span><Link className="btn sm alt" href={`/reports/${r.id}`}>Review</Link></span>
          </div>
        ))}
      </div>
    </div>
  );
}
