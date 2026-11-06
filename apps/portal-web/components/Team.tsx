'use client';
import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

type Role = 'worker' | 'supervisor' | 'management' | 'admin';
type U = { id: string; staffNumber: string; fullName: string; role: Role; status: string; supervisorId: string | null };
type Issued = { name: string; code: string; expiresAt: string };

function CodeCard({ issued, onClose }: { issued: Issued; onClose?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codebox" role="status">
      <p className="sub">One-time activation code for {issued.name}</p>
      <div className="code">{issued.code}</div>
      <p className="sub">Give this to {issued.name}. It works once and expires on {new Date(issued.expiresAt).toLocaleDateString('en-GB')}. They open the portal, choose “Set up your access”, and create their own PIN or password. You never see it.</p>
      <div className="actions" style={{ justifyContent: 'center', marginTop: 12 }}>
        <button className="btn sm lt" style={{ marginTop: 0 }} onClick={async () => { await navigator.clipboard?.writeText(issued.code); setCopied(true); }}>{copied ? 'Copied' : 'Copy code'}</button>
        {onClose && <button className="btn sm lt" style={{ marginTop: 0 }} onClick={onClose}>Done</button>}
      </div>
    </div>
  );
}

export function AddEmployee({ role, supervisors }: { role: Role; supervisors: U[] }) {
  const [issued, setIssued] = useState<Issued | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newRole, setNewRole] = useState<Role>('worker');
  const options: Role[] = role === 'supervisor' ? ['worker'] : role === 'management' ? ['worker', 'supervisor'] : ['worker', 'supervisor', 'management', 'admin'];

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError('');
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { staffNumber: String(f.get('staffNumber')).trim(), fullName: String(f.get('fullName')).trim(), role: newRole };
    if (f.get('phone')) body.phone = String(f.get('phone')).trim();
    if (newRole === 'worker' && role !== 'supervisor' && f.get('supervisorId')) body.supervisorId = f.get('supervisorId');
    const res = await fetch('/api/svc/identity/v1/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(res.status === 409 ? 'A person with this staff number already exists.' : res.status === 403 ? 'You cannot add this kind of account.' : 'Please check the details and try again.'); return; }
    setIssued({ name: body.fullName as string, code: data.activationCode, expiresAt: data.expiresAt });
    (e.target as HTMLFormElement).reset();
  }

  return (
    <div className="stack" style={{ maxWidth: 560 }}>
      {issued && <CodeCard issued={issued} onClose={() => setIssued(null)} />}
      <form onSubmit={submit} className="card stack" noValidate>
        <b>Employee details</b>
        {error && <div className="err" role="alert">{error}</div>}
        <label>Staff number<input name="staffNumber" required /></label>
        <label>Full name<input name="fullName" required /></label>
        <label>Phone number (optional)<input name="phone" type="tel" /></label>
        {options.length > 1 && <label>Role<select value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>{options.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}</select></label>}
        {newRole === 'worker' && role !== 'supervisor' && supervisors.length > 0 && (
          <label>Supervisor<select name="supervisorId" defaultValue=""><option value="">Not assigned yet</option>{supervisors.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        )}
        <button className="btn" disabled={busy}>{busy ? 'Adding…' : 'Add employee'}</button>
        <p className="mini">The employee sets their own PIN or password the first time they log in. Nobody else ever knows it.</p>
      </form>
      <Link href="/team">Back to team</Link>
    </div>
  );
}

export function TeamList({ users, canReset }: { users: U[]; canReset: boolean }) {
  const router = useRouter();
  const [issued, setIssued] = useState<Issued | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function reset(u: U) {
    if (!confirm(`Reset access for ${u.fullName}? Their current PIN or password stops working and they will need a new code.`)) return;
    setBusy(u.id); setError('');
    const res = await fetch(`/api/svc/identity/v1/users/${u.id}/reset-access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setError('Access could not be reset for this person.'); return; }
    setIssued({ name: u.fullName, code: data.activationCode, expiresAt: data.expiresAt });
    router.refresh();
  }

  return (
    <div className="stack">
      {issued && <CodeCard issued={issued} onClose={() => setIssued(null)} />}
      {error && <div className="err" role="alert">{error}</div>}
      <div className="card">
        {users.length === 0 && <p className="sub">No team members yet. Add your first employee.</p>}
        {users.map((u) => (
          <div className="li" key={u.id}>
            <span>{u.fullName}<small>{u.staffNumber} · {u.role}</small></span>
            <span className="actions" style={{ alignItems: 'center' }}>
              <span className={`chip ${u.status === 'active' ? 'ok' : 'wn'}`}>{u.status === 'active' ? 'Active' : 'Awaiting setup'}</span>
              {canReset && <button className="link" disabled={busy === u.id} onClick={() => reset(u)}>{u.status === 'active' ? 'Reset access' : 'New code'}</button>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
