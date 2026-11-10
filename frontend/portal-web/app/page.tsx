'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Logo } from '@/components/Icons';

export default function Splash() {
  const router = useRouter();
  useEffect(() => {
    let alive = true;
    (async () => {
      const [s] = await Promise.all([
        fetch('/api/auth/session', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ authenticated: false })),
        new Promise((r) => setTimeout(r, 700)),
      ]);
      if (alive) router.replace(s.authenticated ? '/home' : '/login');
    })();
    return () => { alive = false; };
  }, [router]);
  return (
    <main className="splash">
      <Logo />
      <h1 className="h" style={{ margin: 0 }}>PresenceHub</h1>
      <p style={{ opacity: 0.8, fontSize: 14 }}>Verified workforce attendance</p>
      <div className="bar"><i /></div>
      <p style={{ opacity: 0.7, fontSize: 12 }} role="status">Securing your session…</p>
    </main>
  );
}
