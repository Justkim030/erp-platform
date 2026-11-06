'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getReading } from '@/lib/geo';
import { duration, timeOf } from '@/lib/labels';

type Site = { id: string; name: string };
type Result = { outcome: 'accepted' | 'review' | 'declined'; message: string };

export function ClockCard({ state, since, sites, siteId: openSite }: { state: 'in' | 'out'; since: string | null; sites: Site[]; siteId: string | null }) {
  const router = useRouter();
  const [siteId, setSiteId] = useState(openSite ?? sites[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState(false);
  const [summary, setSummary] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const kind = state === 'in' ? 'out' : 'in';

  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const mins = state === 'in' && since && now ? Math.max(0, Math.floor((now - Date.parse(since)) / 60_000)) : null;

  async function submit(requestReview: boolean) {
    setBusy(true); setResult(null);
    let reading;
    try { reading = await getReading(); }
    catch (e) {
      if (!requestReview) { setResult({ outcome: 'declined', message: (e as Error).message }); setBusy(false); return; }
    }
    const body: Record<string, unknown> = { siteId: siteId || undefined, reading, requestReview: requestReview || undefined };
    if (kind === 'out') body.workSummary = summary.trim();
    const res = await fetch(`/api/svc/attendance/v1/attendance/clock-${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setResult({ outcome: 'declined', message: res.status === 400 ? 'Please check the details, and write what you worked on (at least 10 characters).' : typeof data.message === 'string' ? data.message : 'Something went wrong. Please try again.' });
      if (res.status === 409) router.refresh();
      return;
    }
    setResult({ outcome: data.outcome, message: data.message });
    if (data.outcome !== 'declined') { setPanel(false); setSummary(''); router.refresh(); }
  }

  return (
    <div className="stack">
      <div className="hero">
        <span className="chip">{state === 'in' ? 'Clocked in' : 'Not clocked in'}</span>
        <div className="num">{state === 'in' && since ? timeOf(since) : '--:--'}</div>
        <p className="sub">{state === 'in' ? `Since ${timeOf(since!)}${mins !== null ? ` · ${duration(mins)} so far` : ''}` : 'Clock in when you arrive at work.'}</p>
        {state === 'out' && sites.length > 1 && (
          <label style={{ color: '#fff', marginTop: 12 }}>Site
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </label>
        )}
        {!panel && <button type="button" className="btn lt" disabled={busy || sites.length === 0} onClick={() => (kind === 'out' ? setPanel(true) : submit(false))}>{busy ? 'Checking…' : kind === 'in' ? 'Clock in' : 'Clock out'}</button>}
        {sites.length === 0 && <p className="sub" style={{ marginTop: 8 }}>No site has been set up yet. Ask your manager.</p>}
      </div>

      {panel && (
        <div className="card stack">
          <b>Report the work you did</b>
          <p className="sub">Your clock-out is submitted together with a short note on what you worked on.</p>
          <textarea value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} placeholder="For example: Packed 40 crates and loaded the afternoon delivery." aria-label="Work done" />
          <div className="actions">
            <button type="button" className="btn" disabled={busy || summary.trim().length < 10} onClick={() => submit(false)}>{busy ? 'Checking…' : 'Submit report and clock out'}</button>
            <button type="button" className="btn alt" disabled={busy} onClick={() => setPanel(false)}>Cancel</button>
          </div>
        </div>
      )}

      {result && (
        <div className={result.outcome === 'declined' ? 'err' : result.outcome === 'review' ? 'notice' : 'card'} role="status">
          <b style={{ display: 'block', marginBottom: 4 }}>{result.outcome === 'accepted' ? 'Done' : result.outcome === 'review' ? 'Recorded for review' : 'Not recorded'}</b>
          {result.message}
          {result.outcome === 'declined' && (
            <div style={{ marginTop: 10 }} className="actions">
              <button type="button" className="btn sm alt" disabled={busy} onClick={() => submit(false)}>Try again</button>
              <button type="button" className="btn sm" disabled={busy || (kind === 'out' && summary.trim().length < 10)} onClick={() => submit(true)}>Ask my supervisor to review</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
