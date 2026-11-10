'use client';
import { useState } from 'react';

type Site = { id: string; name: string };
type Issue = { id: string; kind: 'in' | 'out'; at: string; outcome: string; reviewDecision?: string | null };
export function ExceptionRequestForm({ state, sessionId, sites, issues }: { state: 'in' | 'out'; sessionId?: string | null; sites: Site[]; issues: Issue[] }) {
  const [type, setType] = useState<'missed_clock_out' | 'missed_clock_in' | 'location_issue'>(state === 'in' ? 'missed_clock_out' : 'missed_clock_in');
  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  const [issueId, setIssueId] = useState(issues[0]?.id ?? '');
  const [occurredAt, setOccurredAt] = useState('');
  const [reason, setReason] = useState('');
  const [workSummary, setWorkSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    const body: Record<string, unknown> = {
      type, occurredAt: type === 'location_issue'
        ? issues.find((issue) => issue.id === issueId)?.at
        : new Date(occurredAt).toISOString(),
      reason: reason.trim(),
    };
    if (type === 'missed_clock_out') {
      body.sessionId = sessionId;
      body.workSummary = workSummary.trim();
    } else if (type === 'missed_clock_in') body.siteId = siteId;
    else body.eventId = issueId;
    const res = await fetch('/api/svc/attendance/v1/attendance/exceptions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(typeof data.message === 'string' ? data.message : 'The correction request could not be submitted.');
      return;
    }
    setSaved(true); setReason(''); setWorkSummary('');
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <div><b>Request an attendance correction</b><p className="sub">A supervisor or manager will review it. Approved corrections are recorded as audited entries; original events are preserved.</p></div>
      <label>Issue
        <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          {state === 'in' ? <option value="missed_clock_out">Missed clock-out</option> : <option value="missed_clock_in">Missed clock-in</option>}
          {issues.length > 0 && <option value="location_issue">Flagged location or attendance issue</option>}
        </select>
      </label>
      {type === 'location_issue' ? <label>Flagged attendance entry
        <select required value={issueId} onChange={(e) => setIssueId(e.target.value)}>
          {issues.map((issue) => <option key={issue.id} value={issue.id}>{issue.kind === 'in' ? 'Clock-in' : 'Clock-out'} · {new Date(issue.at).toLocaleString()} · {issue.outcome}</option>)}
        </select>
      </label> : <label>When did it happen?
        <input type="datetime-local" required value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
      </label>}
      {type === 'missed_clock_in' && <label>Work site
        <select required value={siteId} onChange={(e) => setSiteId(e.target.value)}>{sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select>
      </label>}
      {type === 'missed_clock_out' && <label>Work completed
        <textarea required minLength={10} maxLength={2000} value={workSummary} onChange={(e) => setWorkSummary(e.target.value)} />
      </label>}
      <label>Reason
        <textarea required minLength={10} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Explain what happened and why a correction is needed." />
      </label>
      {error && <div className="err" role="alert">{error}</div>}
      {saved && <p className="notice" role="status">Correction request submitted for review.</p>}
      <button className="btn sm" type="submit" disabled={busy || (type !== 'location_issue' && !occurredAt) || (type === 'location_issue' && !issueId) || reason.trim().length < 10 || (type === 'missed_clock_out' && (!sessionId || workSummary.trim().length < 10)) || (type === 'missed_clock_in' && !siteId)}>{busy ? 'Submitting…' : 'Submit request'}</button>
    </form>
  );
}
