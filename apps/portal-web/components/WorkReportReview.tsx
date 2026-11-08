'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function WorkReportReview({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function review(decision: 'acknowledged' | 'clarification' | 'rejected') {
    setBusy(true); setError('');
    const res = await fetch(`/api/svc/attendance/v1/work-reports/${reportId}/review`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, note: note.trim() || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(typeof data.message === 'string' ? data.message : 'The report could not be updated.');
      return;
    }
    router.refresh();
  }

  return (
    <div className="card stack">
      <b>Review activity report</b>
      <label>Note for the worker (optional)
        <textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && <div className="err" role="alert">{error}</div>}
      <div className="actions">
        <button className="btn sm" disabled={busy} onClick={() => review('acknowledged')}>Acknowledge</button>
        <button className="btn sm alt" disabled={busy} onClick={() => review('clarification')}>Request clarification</button>
        <button className="btn sm alt" disabled={busy} onClick={() => review('rejected')}>Reject</button>
      </div>
    </div>
  );
}
