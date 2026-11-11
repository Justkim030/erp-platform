import Link from 'next/link';
import { LogoutButton } from '@/components/LogoutButton';
import { PasskeyManager } from '@/components/PasskeyManager';
import { getSession, svc } from '@/lib/session';

const ROLE_LABEL = { worker: 'Worker', supervisor: 'Supervisor', management: 'Management', admin: 'Administrator' } as const;
const RETENTION_DAYS = process.env.NEXT_PUBLIC_RETENTION_DAYS ?? '90';

export default async function ProfilePage() {
  const u = (await getSession())!;
  const passkeys = u.role === 'worker' ? await svc<any[]>('identity', '/v1/auth/passkeys') : [];
  const initials = u.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      <div><p className="eb">Staff no. {u.staffNumber}</p><h1 className="h">Profile</h1></div>
      <div className="card"><div className="id"><div className="av">{initials}</div><div><b style={{ fontSize: 17 }}>{u.fullName}</b><p className="sub">{ROLE_LABEL[u.role]} · {u.tenant.name}</p></div></div></div>
      <p className="sec">Account</p>
      <div className="card">
        <div className="li"><span>Organisation<small>{u.tenant.name}</small></span></div>
        <div className="li"><span>Role<small>{ROLE_LABEL[u.role]}</small></span></div>
        <div className="li"><span>Phone<small>{u.phone ?? 'Not provided'}</small></span></div>
      </div>
      <p className="sec">Security</p>
      {u.role === 'worker'
        ? passkeys ? <PasskeyManager passkeys={passkeys} /> : <p className="notice">Passkey settings are unavailable right now. Refresh the page to try again.</p>
        : <div className="card"><p className="sub">Passkeys are currently used by workers to confirm clock-ins.</p></div>}
      <p className="sec">Privacy and data</p>
      <div className="card"><div className="li"><span>What we collect<small>Account details and clock-in times. No location tracking. Full details: <Link href="/privacy">privacy notice</Link>.</small></span></div></div>
      <div className="card stack">
        <b>Your data rights</b>
        <p className="sub">You can ask your employer at any time to:</p>
        <div className="li"><span>See your data<small>What we hold about you, including your clock history and any saved work reports.</small></span></div>
        <div className="li"><span>Correct your data<small>Wrong name, phone number or staff record — your supervisor can fix it.</small></span></div>
        <div className="li"><span>Delete your data<small>When you leave the company. Location points are already erased automatically after {RETENTION_DAYS} days.</small></span></div>
        <p className="sub">Requests go through your supervisor or the person who manages attendance. This system records who viewed your locations and when, and never tracks movement between clock events.</p>
      </div>
      <LogoutButton />
    </div>
  );
}
