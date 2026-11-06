'use client';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { getReading } from '@/lib/geo';
import { Map } from './MapLoader';

type Site = { id: string; name: string; lat: number; lng: number; radiusM: number; accuracyLimitM: number; shiftStart: string; graceMinutes: number; allowedIps: string[]; requireNetwork: boolean };
const blank = { id: '', name: '', radiusM: 150, accuracyLimitM: 100, shiftStart: '08:00', graceMinutes: 10, allowedIps: '', requireNetwork: false };

export function SiteEditor({ sites }: { sites: Site[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string>('');
  const [f, setF] = useState<typeof blank>(blank);
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function edit(s?: Site) {
    setMsg(null);
    if (!s) { setEditing(''); setF(blank); setPos(null); return; }
    setEditing(s.id); setPos({ lat: s.lat, lng: s.lng });
    setF({ id: s.id, name: s.name, radiusM: s.radiusM, accuracyLimitM: s.accuracyLimitM, shiftStart: s.shiftStart, graceMinutes: s.graceMinutes, allowedIps: s.allowedIps.join(', '), requireNetwork: s.requireNetwork });
  }
  async function here() {
    try { const r = await getReading(); setPos({ lat: r.lat, lng: r.lng }); setMsg(null); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!pos) { setMsg({ ok: false, text: 'Click the map where the site is, or use your current location.' }); return; }
    setBusy(true); setMsg(null);
    const body = {
      name: f.name.trim(), lat: pos.lat, lng: pos.lng, radiusM: Number(f.radiusM), accuracyLimitM: Number(f.accuracyLimitM), shiftStart: f.shiftStart, graceMinutes: Number(f.graceMinutes),
      allowedIps: f.allowedIps.split(',').map((s) => s.trim()).filter(Boolean), requireNetwork: f.requireNetwork,
    };
    const res = await fetch(`/api/svc/attendance/v1/sites${editing ? `/${editing}` : ''}`, { method: editing ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: 'The site could not be saved. Check the name, radius (20 to 5000 m), shift time and IP addresses.' }); return; }
    setMsg({ ok: true, text: 'Site saved.' });
    if (!editing) edit();
    router.refresh();
  }
  const set = (k: keyof typeof blank) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  return (
    <div className="stack">
      <div className="card">
        <b>Sites</b>
        {sites.length === 0 && <p className="sub">No site yet. Add your first one below.</p>}
        {sites.map((s) => (
          <div className="li" key={s.id}><span>{s.name}<small>{s.radiusM} m radius · shift {s.shiftStart} · grace {s.graceMinutes} min{s.requireNetwork ? ' · staff network required' : ''}</small></span><button className="link" onClick={() => edit(s)}>Edit</button></div>
        ))}
      </div>
      <form onSubmit={save} className="card stack" noValidate>
        <b>{editing ? 'Edit site' : 'Add a site'}</b>
        {msg && <div className={msg.ok ? 'notice' : 'err'} role="status">{msg.text}</div>}
        <Map sites={sites.filter((s) => s.id !== editing)} pick={pos ? { ...pos, radiusM: Number(f.radiusM) || 150 } : null} onPick={(lat, lng) => setPos({ lat, lng })} />
        <div className="actions"><button type="button" className="btn sm alt" onClick={here}>Use my current location</button>{pos && <span className="mini" style={{ alignSelf: 'center' }}>{pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}</span>}</div>
        <label>Site name<input value={f.name} onChange={set('name')} required /></label>
        <label>Boundary radius (metres)<input type="number" min={20} max={5000} value={f.radiusM} onChange={set('radiusM')} /></label>
        <label>Shift starts<input type="time" value={f.shiftStart} onChange={set('shiftStart')} /></label>
        <label>Grace period (minutes)<input type="number" min={0} max={180} value={f.graceMinutes} onChange={set('graceMinutes')} /></label>
        <label>Acceptable location accuracy (metres)<input type="number" min={10} max={1000} value={f.accuracyLimitM} onChange={set('accuracyLimitM')} /></label>
        <label>Staff network public IP addresses (optional, comma separated)<input value={f.allowedIps} onChange={set('allowedIps')} placeholder="41.90.12.34, 196.201.0.0/24" /></label>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><input style={{ width: 20, height: 20 }} type="checkbox" checked={f.requireNetwork} onChange={set('requireNetwork')} />Require the staff network to clock in</label>
        <p className="mini">With the network required, anyone on a different connection is declined, so confirm the address with your internet provider first. Without it, a different network only sends the entry for review.</p>
        <div className="actions"><button className="btn" style={{ width: 'auto', padding: '0 24px' }} disabled={busy}>{busy ? 'Saving…' : 'Save site'}</button>{editing && <button type="button" className="btn alt" style={{ width: 'auto', padding: '0 24px' }} onClick={() => edit()}>New site</button>}</div>
      </form>
    </div>
  );
}
