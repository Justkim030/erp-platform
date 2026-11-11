'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { AuthFrame } from '@/components/AuthFrame';

export default function ActivatePage() {
  const router = useRouter();
  const [type, setType] = useState<'pin' | 'password'>('pin');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('secret') !== f.get('confirm')) { setError(`The two ${type === 'pin' ? 'PINs' : 'passwords'} do not match.`); return; }
    setBusy(true); setError('');
    const res = await fetch('/api/auth/activate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        staffNumber: f.get('staffNumber'), activationCode: f.get('activationCode'), credentialType: type, secret: f.get('secret'), phone: f.get('phone'),
        organisation: new URLSearchParams(location.search).get('org') || undefined,
      }),
    });
    if (res.ok) { router.replace('/home'); router.refresh(); return; }
    setError((await res.json().catch(() => ({}))).error ?? 'Something went wrong. Please try again.');
    setBusy(false);
  }

  return (
    <AuthFrame>
      <div><p className="eb">First-time access</p><h1 className="h">Set up your access</h1><p className="sub">Your supervisor gave you a one-time activation code. Use it once, choose how you will log in, and from then on just log in.</p></div>
      <form onSubmit={submit} className="stack" noValidate>
        {error && <div className="err" role="alert">{error}</div>}
        <label>Staff number<input name="staffNumber" autoComplete="username" required /></label>
        <label>Activation code<input name="activationCode" autoCapitalize="characters" autoComplete="one-time-code" placeholder="XXXXX-XXXXX" required /></label>
        <div className="seg" role="tablist" aria-label="Log in with">
          <button type="button" role="tab" aria-selected={type === 'pin'} className={type === 'pin' ? 'on' : ''} onClick={() => setType('pin')}>PIN</button>
          <button type="button" role="tab" aria-selected={type === 'password'} className={type === 'password' ? 'on' : ''} onClick={() => setType('password')}>Password</button>
        </div>
        <p className="sub">{type === 'pin' ? 'A PIN is 6 to 8 digits and is available to workers. Avoid simple patterns such as 123456.' : 'At least 10 characters. Supervisors and managers must use a password.'}</p>
        <label>{type === 'pin' ? 'Choose a PIN' : 'Choose a password'}<input name="secret" type="password" inputMode={type === 'pin' ? 'numeric' : 'text'} autoComplete="new-password" required /></label>
        <label>Confirm<input name="confirm" type="password" inputMode={type === 'pin' ? 'numeric' : 'text'} autoComplete="new-password" required /></label>
        <label>Phone number (optional)<input name="phone" type="tel" autoComplete="tel" /></label>
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save and continue'}</button>
      </form>
      <p className="sub" style={{ textAlign: 'center' }}>By continuing you acknowledge the <Link href="/privacy">privacy notice</Link>. Already set up? <Link href="/login">Log in</Link></p>
    </AuthFrame>
  );
}
