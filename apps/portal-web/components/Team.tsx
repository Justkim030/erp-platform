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
    const supervisorId = f.get('supervisorId');
    if (newRole === 'worker' && role !== 'supervisor' && supervisors.length > 0 && !supervisorId) {
      setBusy(false); setError('Choose an active supervisor for this worker.'); return;
    }
    if (newRole === 'worker' && role !== 'supervisor' && supervisorId) body.supervisorId = supervisorId;
    const res = await fetch('/api/svc/identity/v1/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      const message = Array.isArray(data.message) ? data.message.join(' ') : data.message;
      setError(res.status === 409 ? 'A person with this staff number already exists.' : res.status === 403 ? 'You cannot add this kind of account.' : typeof message === 'string' ? message : 'Please check the details and try again.');
      return;
    }
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
          <label>Supervisor
            <select name="supervisorId" defaultValue={supervisors.length === 1 ? supervisors[0].id : ''} required>
              <option value="" disabled>Choose an active supervisor</option>
              {supervisors.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
            </select>
          </label>
        )}
        {newRole === 'worker' && role !== 'supervisor' && supervisors.length === 0 && (
          <p className="mini">No active supervisor is available. You can add this worker now and assign them after creating a supervisor.</p>
        )}
        <button className="btn" disabled={busy}>{busy ? 'Adding…' : 'Add employee'}</button>
        <p className="mini">The employee sets their own PIN or password the first time they log in. Nobody else ever knows it.</p>
      </form>
      <Link href="/team">Back to team</Link>
    </div>
  );
}

export function TeamList({ users, canReset, canAssign, supervisors }: { users: U[]; canReset: boolean; canAssign: boolean; supervisors: U[] }) {
  const router = useRouter();
  const [issued, setIssued] = useState<Issued | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [assignment, setAssignment] = useState<Record<string, string>>({});

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

  async function assign(u: U) {
    const supervisorId = assignment[u.id] ?? u.supervisorId ?? '';
    const supervisor = supervisors.find((s) => s.id === supervisorId);
    if (!supervisor) { setError('Choose an active supervisor before assigning this worker.'); return; }
    if (supervisorId === u.supervisorId) return;
    if (!confirm(`Assign ${u.fullName} to ${supervisor.fullName}? This change will be recorded in the assignment history.`)) return;
    setBusy(u.id); setError('');
    const res = await fetch(`/api/svc/identity/v1/workers/${u.id}/supervisor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ supervisorId, reason: 'Assigned by management through the team page' }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(typeof data.message === 'string' ? data.message : 'The worker could not be assigned. Please try again.');
      return;
    }
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
              {canAssign && u.role === 'worker' && supervisors.length > 0 && (
                <>
                  <select
                    aria-label={`Supervisor for ${u.fullName}`}
                    value={assignment[u.id] ?? u.supervisorId ?? ''}
                    onChange={(e) => setAssignment((current) => ({ ...current, [u.id]: e.target.value }))}
                    disabled={busy === u.id}
                  >
                    <option value="" disabled>Choose supervisor</option>
                    {u.supervisorId && !supervisors.some((s) => s.id === u.supervisorId) && <option value={u.supervisorId} disabled>Former or inactive supervisor</option>}
                    {supervisors.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
                  </select>
                  <button className="link" disabled={busy === u.id || (assignment[u.id] ?? u.supervisorId) === u.supervisorId} onClick={() => assign(u)}>
                    {busy === u.id ? 'Saving…' : u.supervisorId ? 'Reassign' : 'Assign'}
                  </button>
                </>
              )}
              <span className={`chip ${u.status === 'active' ? 'ok' : 'wn'}`}>{u.status === 'active' ? 'Active' : 'Awaiting setup'}</span>
              {canReset && <button className="link" disabled={busy === u.id} onClick={() => reset(u)}>{u.status === 'active' ? 'Reset access' : 'New code'}</button>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
