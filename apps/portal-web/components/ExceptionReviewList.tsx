'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type ExceptionItem = {
  id: string;
  exception_type: string;
  occurred_at: string;
  reason: string;
  status: string;
  worker_id: string;
  work_summary?: string | null;
  session_id?: string | null;
};

export function ExceptionReviewList({ items, canOverride = false }: { items: ExceptionItem[]; canOverride?: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function review(item: ExceptionItem, decision: 'approved' | 'declined' | 'needs_info', override = false) {
    setBusy(item.id); setError('');
    const url = `/api/svc/attendance/v1/team/attendance/exceptions/${item.id}/${override ? 'override' : 'review'}`;
    const body = override ? { decision, reason: note.trim() } : { decision, note: note.trim() || undefined };
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(typeof data.message === 'string' ? data.message : 'The exception request could not be updated.');
      return;
    }
    router.refresh();
  }

  async function verify(item: ExceptionItem, outcome: 'confirmed' | 'not_found') {
    setBusy(item.id); setError('');
    const res = await fetch(`/api/svc/attendance/v1/attendance/exceptions/${item.id}/verifications`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome, note: note.trim() || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(typeof data.message === 'string' ? data.message : 'The physical verification could not be recorded.');
      return;
    }
    router.refresh();
  }

  if (!items.length) return <p className="sub">No attendance correction requests are waiting.</p>;
  return (
    <div className="stack">
      {error && <div className="err" role="alert">{error}</div>}
      {items.map((item) => (
        <div className="exception-item" key={item.id}>
          <div className="li"><span>{item.exception_type.replace('_', ' ')}<small>Worker {item.worker_id} · {new Date(item.occurred_at).toLocaleString()}</small></span><span className="chip wn">{item.status}</span></div>
          <p className="sub">{item.reason}</p>
          {item.work_summary && <p className="sub">Work summary: {item.work_summary}</p>}
          <label>Review note
            <textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="actions">
            <button className="btn sm" disabled={busy === item.id} onClick={() => review(item, 'approved')}>Approve correction</button>
            <button className="btn sm alt" disabled={busy === item.id} onClick={() => review(item, 'needs_info')}>Request details</button>
            <button className="btn sm alt" disabled={busy === item.id} onClick={() => review(item, 'declined')}>Decline</button>
            <button className="btn sm alt" disabled={busy === item.id} onClick={() => verify(item, 'confirmed')}>Verify in person</button>
            <button className="btn sm alt" disabled={busy === item.id} onClick={() => verify(item, 'not_found')}>Not found</button>
            {canOverride && <button className="btn sm alt" disabled={busy === item.id || note.trim().length < 5} onClick={() => review(item, 'approved', true)}>Management override</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
