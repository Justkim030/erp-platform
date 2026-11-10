import Link from 'next/link';
import { WorkReportEditor } from '@/components/WorkReportEditor';
import { WorkReportReview } from '@/components/WorkReportReview';
import { requireUser, svc } from '@/lib/session';

const pretty = (value: string) => value.replace('_', ' ');

export default async function WorkReportPage({ params }: { params: { id: string } }) {
  const user = await requireUser();
  const report = await svc<any>('attendance', `/v1/work-reports/${encodeURIComponent(params.id)}`);
  if (!report) return <div className="stack"><Link href="/reports">← Work reports</Link><p className="notice">This report is unavailable or you do not have permission to view it.</p></div>;
  const editable = user.role === 'worker' && report.workerId === user.id && ['draft', 'clarification', 'rejected'].includes(report.status);
  return (
    <div className="stack">
      <div><Link href="/reports">← Work reports</Link><p className="eb">Daily activity outcomes</p><h1 className="h">Report details</h1></div>
      <div className="card">
        <div className="li"><span>Report status</span><span className="chip wn">{pretty(report.status)}</span></div>
        <div className="li"><span>Worker ID<small>{report.workerId}</small></span></div>
        <div className="li"><span>Work date<small>{new Date(report.startedAt).toLocaleString()}</small></span></div>
        {report.endedAt && <div className="li"><span>Clocked out<small>{new Date(report.endedAt).toLocaleString()}</small></span></div>}
        {report.reviewNote && <p className="notice">Reviewer note: {report.reviewNote}</p>}
      </div>
      {editable ? <WorkReportEditor sessionId={report.sessionId} initial={report} /> : (
        <div className="card">
          <b>Activities</b>
          {report.activities.map((activity: any) => (
            <div className="li activity-readonly" key={activity.id}>
              <span>{activity.description}
                <small>{pretty(activity.status)}{activity.quantity != null ? ` · ${activity.quantity} ${activity.unit ?? ''}` : ''}</small>
                {activity.challenge && <small>Challenge: {activity.challenge}</small>}
                {activity.notes && <small>{activity.notes}</small>}
              </span>
            </div>
          ))}
        </div>
      )}
      {report.revisions?.length > 1 && (
        <div className="card"><b>Revision history</b>
          {report.revisions.map((revision: any) => <div className="li" key={revision.revision}>Revision {revision.revision}<small>{new Date(revision.createdAt).toLocaleString()}</small></div>)}
        </div>
      )}
      {report.reviews?.length > 0 && (
        <div className="card"><b>Review history</b>
          {report.reviews.map((review: any, i: number) => <div className="li" key={i}><span>{pretty(review.decision)}{review.note && <small>{review.note}</small>}</span><small>{new Date(review.createdAt).toLocaleString()}</small></div>)}
        </div>
      )}
      {report.status === 'submitted' && ['supervisor', 'management', 'admin'].includes(user.role) && <WorkReportReview reportId={report.id} />}
    </div>
  );
}
