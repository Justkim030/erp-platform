'use client';
import { startRegistration } from '@simplewebauthn/browser';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Passkey = { id: string; name: string; deviceType: string; backedUp: boolean; createdAt: string; lastUsedAt: string | null };

async function errorMessage(res: Response, fallback: string) {
  const data = await res.json().catch(() => ({}));
  return typeof data.message === 'string' ? data.message : fallback;
}

export function PasskeyManager({ passkeys }: { passkeys: Passkey[] }) {
  const router = useRouter();
  const [name, setName] = useState('This device');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function add() {
    setError(''); setMessage('');
    if (!window.isSecureContext || !window.PublicKeyCredential) {
      setError('Passkeys require a supported browser and a secure connection (HTTPS or localhost).');
      return;
    }
    setBusy(true);
    try {
      const optionsResponse = await fetch('/api/svc/identity/v1/auth/passkeys/registration/options', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      if (!optionsResponse.ok) { setError(await errorMessage(optionsResponse, 'Passkey setup could not start.')); return; }
      const optionsData = await optionsResponse.json();
      const response = await startRegistration({ optionsJSON: optionsData.options });
      const verified = await fetch('/api/svc/identity/v1/auth/passkeys/registration/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: optionsData.requestId, response, name: name.trim() || 'This device' }),
      });
      if (!verified.ok) { setError(await errorMessage(verified, 'Passkey registration could not be completed.')); return; }
      setMessage('Passkey registered. You will need it to confirm each clock-in.');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error && e.name === 'NotAllowedError'
        ? 'Passkey setup was cancelled or timed out.'
        : 'This browser could not set up a passkey. Try another supported device or browser.');
    } finally { setBusy(false); }
  }

  async function remove(passkey: Passkey) {
    if (!confirm(`Remove “${passkey.name}”? Clock-in passkey confirmation will stop if this is your last passkey.`)) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const res = await fetch(`/api/svc/identity/v1/auth/passkeys/${passkey.id}/remove`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      if (!res.ok) { setError(await errorMessage(res, 'Passkey could not be removed.')); return; }
      setMessage('Passkey removed.');
      router.refresh();
    } catch {
      setError('Passkey could not be removed. Check your connection and try again.');
    } finally { setBusy(false); }
  }

  return (
    <div className="card stack">
      <p className="sub">PIN or password sign-in stays available. After you register a passkey, each clock-in requires confirmation on that device. The browser will ask you to verify with its fingerprint, face recognition, device PIN, or security key.</p>
      {error && <div className="err" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      {passkeys.length === 0 && <p className="sub">No passkey registered. Clock-in will use the normal location and supervisor-review rules until you add one.</p>}
      {passkeys.map((passkey) => (
        <div className="li" key={passkey.id}>
          <span>{passkey.name}<small>Added {new Date(passkey.createdAt).toLocaleDateString('en-GB')} · {passkey.deviceType === 'multiDevice' ? 'Synced passkey' : 'Device passkey'}{passkey.lastUsedAt ? ` · Last used ${new Date(passkey.lastUsedAt).toLocaleDateString('en-GB')}` : ''}</small></span>
          <button type="button" className="link" disabled={busy} onClick={() => remove(passkey)}>Remove</button>
        </div>
      ))}
      <label>Device label<input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></label>
      <button type="button" className="btn" disabled={busy || passkeys.length >= 10} onClick={add}>
        {busy ? 'Waiting for device…' : passkeys.length >= 10 ? 'Maximum passkeys reached' : 'Add a passkey'}
      </button>
    </div>
  );
}
