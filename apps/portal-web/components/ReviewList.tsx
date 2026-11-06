'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { dateOf, reasonText, timeOf } from '@/lib/labels';

export type ReviewItem = { id: string; kind: 'in' | 'out'; at: string; fullName?: string; staffNumber?: string; reasons: string[]; workSummary?: string | null; distanceM?: number | null };

export function ReviewList({ items }: { items: ReviewItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function decide(id: string, decision: 'approved' | 'declined') {
    setBusy(id); setError('');
    const res = await fetch(`/api/svc/attendance/v1/attendance/events/${id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });
    setBusy(null);
    if (!res.ok) { setError('That entry could not be updated. Refresh and try again.'); return; }
    router.refresh();
  }

  if (!items.length) return <p className="sub">Nothing is waiting for your decision.</p>;
  return (
    <div>
      {error && <div className="err" role="alert">{error}</div>}
      {items.map((e) => (
        <div className="li" key={e.id} style={{ alignItems: 'flex-start' }}>
          <span style={{ flex: 1 }}>
            {e.fullName ?? 'Employee'} · {e.kind === 'in' ? 'clock-in' : 'clock-out'} {timeOf(e.at)}
            <small>{dateOf(e.at)}{e.staffNumber ? ` · ${e.staffNumber}` : ''}</small>
            <small>{e.reasons.map(reasonText).join(' · ')}{e.distanceM != null ? ` · ${e.distanceM} m from centre` : ''}</small>
            {e.workSummary && <small>Work done: {e.workSummary}</small>}
          </span>
          <span className="actions">
            <button className="btn sm" disabled={busy === e.id} onClick={() => decide(e.id, 'approved')}>Approve</button>
            <button className="btn sm alt" disabled={busy === e.id} onClick={() => decide(e.id, 'declined')}>Decline</button>
          </span>
        </div>
      ))}
    </div>
  );
}
