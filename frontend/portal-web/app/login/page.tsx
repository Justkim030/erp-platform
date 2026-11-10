'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { AuthFrame } from '@/components/AuthFrame';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError('');
    const f = new FormData(e.currentTarget);
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staffNumber: f.get('staffNumber'), password: f.get('password'), organisation: new URLSearchParams(location.search).get('org') || undefined }),
    });
    if (res.ok) { router.replace('/home'); router.refresh(); return; }
    setError((await res.json().catch(() => ({}))).error ?? 'Something went wrong. Please try again.');
    setBusy(false);
  }

  return (
    <AuthFrame>
      <div><p className="eb">Welcome</p><h1 className="h">Log in</h1><p className="sub">Enter your staff number and your password or PIN.</p></div>
      <form onSubmit={submit} className="stack" noValidate>
        {error && <div className="err" role="alert">{error}</div>}
        <label>Staff number<input name="staffNumber" autoComplete="username" required /></label>
        <label>Password or PIN<input name="password" type="password" autoComplete="current-password" required /></label>
        <button className="btn" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
      </form>
      <p className="sub" style={{ textAlign: 'center' }}>First time here? <Link href="/activate">Set up your access</Link></p>
      <p className="sub" style={{ textAlign: 'center' }}>Forgot your PIN or password? Ask your supervisor for a new activation code.</p>
    </AuthFrame>
  );
}
