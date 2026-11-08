'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { getReading, type Reading } from '@/lib/geo';
import { duration, timeOf } from '@/lib/labels';

type Site = { id: string; name: string };
type Result = { outcome: 'accepted' | 'review' | 'declined'; message: string };
type PendingPasskey = { requestId: string; optionsJSON: PublicKeyCredentialRequestOptionsJSON; reading?: Reading; requestReview: boolean };

export function ClockCard({ state, since, sites, siteId: openSite }: {
  state: 'in' | 'out'; since: string | null; sites: Site[]; siteId: string | null;
}) {
  const router = useRouter();
  const [siteId, setSiteId] = useState(openSite ?? sites[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [locationConsent, setLocationConsent] = useState<boolean | null>(null);
  const [pendingPasskey, setPendingPasskey] = useState<PendingPasskey | null>(null);
  const kind = state === 'in' ? 'out' : 'in';

  useEffect(() => { setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const mins = state === 'in' && since && now ? Math.max(0, Math.floor((now - Date.parse(since)) / 60_000)) : null;

  async function record(requestReview: boolean, reading?: Reading, passkeyProof?: string) {
    const body: Record<string, unknown> = { siteId: siteId || undefined, reading, requestReview: requestReview || undefined, passkeyProof };
    let res: Response;
    try {
      res = await fetch(`/api/svc/attendance/v1/attendance/clock-${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      setBusy(false);
      setResult({ outcome: 'declined', message: 'Attendance could not be recorded. Check your connection and try again.' });
      return;
    }
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      const message = typeof data.message === 'string'
        ? data.message
        : Array.isArray(data.message)
          ? data.message.filter((item: unknown): item is string => typeof item === 'string').join(' ')
          : '';
      setResult({
        outcome: 'declined',
        message: message || 'Attendance could not be recorded. Check the selected site and location permission, then try again.',
      });
      if (res.status === 409) router.refresh();
      return;
    }
    setResult({ outcome: data.outcome, message: data.message });
    if (data.outcome !== 'declined') router.refresh();
  }

  async function continueAfterConsent(requestReview: boolean) {
    setLocationConsent(null); setBusy(true); setResult(null);
    let reading: Reading | undefined;
    try { reading = await getReading(); }
    catch (e) {
      if (!requestReview) { setResult({ outcome: 'declined', message: (e as Error).message }); setBusy(false); return; }
    }

    if (kind === 'in') {
      let optionsResponse: Response;
      try {
        optionsResponse = await fetch('/api/svc/identity/v1/auth/passkeys/clock/options', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        });
      } catch {
        setBusy(false);
        setResult({ outcome: 'declined', message: 'Passkey verification is unavailable. No clock-in was recorded.' });
        return;
      }
      const optionsData = await optionsResponse.json().catch(() => ({}));
      if (!optionsResponse.ok) {
        setBusy(false);
        setResult({ outcome: 'declined', message: typeof optionsData.message === 'string' ? optionsData.message : 'Passkey verification is unavailable. No clock-in was recorded.' });
        return;
      }
      if (optionsData.required) {
        setPendingPasskey({ requestId: optionsData.requestId, optionsJSON: optionsData.options, reading, requestReview });
        setBusy(false);
        return;
      }
    }
    await record(requestReview, reading);
  }

  async function confirmPasskey() {
    if (!pendingPasskey) return;
    setBusy(true); setResult(null);
    try {
      const response = await startAuthentication({ optionsJSON: pendingPasskey.optionsJSON });
      const verification = await fetch('/api/svc/identity/v1/auth/passkeys/clock/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: pendingPasskey.requestId, response }),
      });
      const data = await verification.json().catch(() => ({}));
      if (!verification.ok || typeof data.proof !== 'string') {
        setBusy(false); setPendingPasskey(null);
        setResult({ outcome: 'declined', message: typeof data.message === 'string' ? data.message : 'Passkey verification failed. No clock-in was recorded.' });
        return;
      }
      const pending = pendingPasskey;
      setPendingPasskey(null);
      await record(pending.requestReview, pending.reading, data.proof);
    } catch (e) {
      setBusy(false); setPendingPasskey(null);
      const message = e instanceof Error && e.name === 'NotAllowedError'
        ? 'Passkey confirmation was cancelled or timed out. No clock-in was recorded.'
        : 'This device could not confirm the clock-in with a passkey. No clock-in was recorded.';
      setResult({ outcome: 'declined', message });
    }
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
        <button type="button" className="btn lt" disabled={busy || sites.length === 0} onClick={() => setLocationConsent(false)}>
          {busy ? 'Checking…' : kind === 'in' ? 'Clock in' : 'Clock out'}
        </button>
        {kind === 'out' && <p className="sub" style={{ marginTop: 10 }}>Clock out when you leave. Submit your activity report afterwards.</p>}
        {sites.length === 0 && <p className="sub" style={{ marginTop: 8 }}>No site has been set up yet. Ask your manager.</p>}
      </div>

      {locationConsent !== null && (
        <div className="card stack" role="dialog" aria-modal="true" aria-labelledby="location-consent-title">
          <b id="location-consent-title">Allow a one-time location reading?</b>
          <p className="sub">Your browser will ask to share your location for this clock event only. We do not track you in the background.</p>
          <div className="actions">
            <button type="button" className="btn sm" onClick={() => continueAfterConsent(locationConsent)}>Continue and ask browser</button>
            <button type="button" className="btn sm alt" onClick={() => setLocationConsent(null)}>Cancel</button>
          </div>
        </div>
      )}
      {pendingPasskey && (
        <div className="card stack" role="dialog" aria-modal="true" aria-labelledby="passkey-clock-title">
          <b id="passkey-clock-title">Confirm this clock-in with your passkey</b>
          <p className="sub">Use your device’s fingerprint, face recognition, PIN, or registered security key. No clock-in will be recorded unless confirmation succeeds.</p>
          <div className="actions">
            <button type="button" className="btn sm" disabled={busy} onClick={confirmPasskey}>{busy ? 'Waiting for passkey…' : 'Confirm with passkey'}</button>
            <button type="button" className="btn sm alt" disabled={busy} onClick={() => setPendingPasskey(null)}>Cancel</button>
          </div>
        </div>
      )}

      {result && (
        <div className={result.outcome === 'declined' ? 'err' : result.outcome === 'review' ? 'notice' : 'card'} role="status">
          <b style={{ display: 'block', marginBottom: 4 }}>{result.outcome === 'accepted' ? 'Done' : result.outcome === 'review' ? 'Recorded for review' : 'Not recorded'}</b>
          {result.message}
          {result.outcome === 'declined' && (
            <div style={{ marginTop: 10 }} className="actions">
              <button type="button" className="btn sm alt" disabled={busy} onClick={() => setLocationConsent(false)}>Try again</button>
              <button type="button" className="btn sm" disabled={busy} onClick={() => setLocationConsent(true)}>Ask my supervisor to review</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
