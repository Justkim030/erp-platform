'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Activity = {
  description: string;
  status: 'completed' | 'in_progress' | 'blocked';
  quantity: string;
  unit: string;
  challenge: string;
  notes: string;
  taskId: string;
};
type Task = { id: string; title: string; status: string };
type SavedReport = { id: string; status: string; activities: Array<Partial<Activity> & { quantity?: number | null }> };
const blank = (): Activity => ({ description: '', status: 'completed', quantity: '', unit: '', challenge: '', notes: '', taskId: '' });

export function WorkReportEditor({ sessionId, initial, tasks = [] }: { sessionId: string; initial?: SavedReport | null; tasks?: Task[] }) {
  const router = useRouter();
  const [report, setReport] = useState(initial ?? null);
  const [activities, setActivities] = useState<Activity[]>(initial?.activities.length
    ? initial.activities.map((item) => ({
      description: item.description ?? '',
      status: item.status ?? 'completed',
      quantity: item.quantity == null ? '' : String(item.quantity),
      unit: item.unit ?? '',
      challenge: item.challenge ?? '',
      notes: item.notes ?? '',
      taskId: item.taskId ?? '',
    }))
    : [blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function update(index: number, patch: Partial<Activity>) {
    setActivities((items) => items.map((item, i) => i === index ? { ...item, ...patch } : item));
  }

  async function save() {
    setBusy(true); setError(''); setMessage('');
    const body = {
      sessionId,
      activities: activities.map((item) => ({
        description: item.description.trim(), status: item.status,
        quantity: item.quantity === '' ? undefined : Number(item.quantity),
        unit: item.unit.trim() || undefined, challenge: item.challenge.trim() || undefined, notes: item.notes.trim() || undefined,
        taskId: item.taskId || undefined,
      })),
    };
    const url = report ? `/api/svc/attendance/v1/work-reports/${report.id}` : '/api/svc/attendance/v1/work-reports';
    const res = await fetch(url, { method: report ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(typeof data.message === 'string' ? data.message : 'The report could not be saved.');
      return null;
    }
    setReport(data);
    setActivities(data.activities.map((item: any) => ({
      description: item.description, status: item.status, quantity: item.quantity == null ? '' : String(item.quantity),
      unit: item.unit ?? '', challenge: item.challenge ?? '', notes: item.notes ?? '',
      taskId: item.taskId ?? '',
    })));
    setMessage('Draft saved.');
    router.refresh();
    return data as SavedReport;
  }

  async function submit() {
    const saved = await save();
    if (!saved) return;
    setBusy(true); setError(''); setMessage('');
    const res = await fetch(`/api/svc/attendance/v1/work-reports/${saved.id}/submit`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(typeof data.message === 'string' ? data.message : 'The report could not be submitted.');
      return;
    }
    setReport({ ...saved, status: 'submitted' });
    setMessage('Daily report submitted for review.');
    router.refresh();
  }

  if (report?.status === 'submitted' || report?.status === 'acknowledged') {
    return <div className="card"><b>Daily report {report.status}</b><p className="sub">Your activities have been submitted and cannot be changed unless a reviewer requests clarification.</p></div>;
  }

  return (
    <div className="card stack">
      <div>
        <b>End-of-shift work report</b>
        <p className="sub">Report assigned tasks and any other work you did today. Linking an assigned task is optional; everyone submits a report after clocking out.</p>
      </div>
      {activities.map((activity, index) => (
        <div className="activity-editor" key={index}>
          <label>Activity
            <textarea value={activity.description} maxLength={1000} onChange={(e) => update(index, { description: e.target.value })} placeholder="What activity did you carry out?" />
          </label>
          <label>Assigned task (optional)
            <select value={activity.taskId} onChange={(e) => update(index, { taskId: e.target.value })}>
              <option value="">Not linked to a task</option>
              {tasks.filter((task) => task.status !== 'cancelled').map((task) => <option key={task.id} value={task.id}>{task.title} · {task.status.replace('_', ' ')}</option>)}
            </select>
          </label>
          <div className="grid2">
            <label>Status
              <select value={activity.status} onChange={(e) => update(index, { status: e.target.value as Activity['status'] })}>
                <option value="completed">Completed</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option>
              </select>
            </label>
            <label>Quantity (optional)
              <input type="number" min="0" step="any" value={activity.quantity} onChange={(e) => update(index, { quantity: e.target.value })} />
            </label>
          </div>
          <label>Unit (optional)
            <input maxLength={80} value={activity.unit} onChange={(e) => update(index, { unit: e.target.value })} placeholder="boxes, metres, orders…" />
          </label>
          <label>Challenge (optional)
            <textarea maxLength={1000} value={activity.challenge} onChange={(e) => update(index, { challenge: e.target.value })} placeholder="Anything that blocked or delayed the work?" />
          </label>
          <label>Notes (optional)
            <textarea maxLength={2000} value={activity.notes} onChange={(e) => update(index, { notes: e.target.value })} />
          </label>
          {activities.length > 1 && <button className="link" type="button" onClick={() => setActivities((items) => items.filter((_, i) => i !== index))}>Remove activity</button>}
        </div>
      ))}
      <button className="btn sm alt" type="button" disabled={busy || activities.length >= 100} onClick={() => setActivities((items) => [...items, blank()])}>Add activity</button>
      {error && <div className="err" role="alert">{error}</div>}
      {message && <p className="notice" role="status">{message}</p>}
      <div className="actions">
        <button className="btn sm alt" type="button" disabled={busy || activities.some((item) => item.description.trim().length < 3)} onClick={save}>{busy ? 'Saving…' : 'Save draft'}</button>
        <button className="btn sm" type="button" disabled={busy || activities.some((item) => item.description.trim().length < 3)} onClick={submit}>{busy ? 'Submitting…' : 'Submit daily report'}</button>
      </div>
    </div>
  );
}
