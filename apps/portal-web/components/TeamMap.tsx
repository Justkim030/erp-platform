'use client';
import { useEffect, useState } from 'react';
import { dateOf, timeOf, todayLocal } from '@/lib/labels';
import { Map } from './MapLoader';
import type { MapPoint, MapSite } from './MapView';

export function TeamMap() {
  const [date, setDate] = useState(todayLocal());
  const [data, setData] = useState<{ points: MapPoint[]; sites: MapSite[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setData(null); setError('');
    fetch(`/api/svc/attendance/v1/team/map?date=${date}`, { cache: 'no-store' })
      .then(async (r) => { if (!r.ok) throw new Error(); const j = await r.json(); if (alive) setData(j); })
      .catch(() => alive && setError('The map could not be loaded. Try again shortly.'));
    return () => { alive = false; };
  }, [date]);

  return (
    <div className="stack">
      <label style={{ maxWidth: 220 }}>Day<input type="date" value={date} max={todayLocal()} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
      {error && <div className="err" role="alert">{error}</div>}
      <Map points={data?.points ?? []} sites={data?.sites ?? []} />
      <div className="legend" aria-label="Map key">
        <span><i style={{ borderColor: '#0b3c49', background: '#1b8a8f' }} />Clock-in</span>
        <span><i style={{ borderColor: '#92400e', background: '#f59e0b' }} />Clock-out</span>
        <span><i style={{ borderColor: '#9a2222', background: 'transparent' }} />Declined</span>
        <span><i style={{ borderColor: '#0b3c49', background: '#1b8a8f', borderStyle: 'dashed' }} />Waiting for review</span>
      </div>
      <div className="card">
        <b>{dateOf(`${date}T12:00:00+03:00`)} · {data ? `${data.points.length} location${data.points.length === 1 ? '' : 's'}` : 'Loading…'}</b>
        {data && data.points.length === 0 && <p className="sub">No locations were recorded for this day. Exact coordinates are erased after the retention period.</p>}
        {data?.points.map((p) => (
          <div className="li" key={p.id}>
            <span>{p.fullName ?? 'Employee'} · {p.kind === 'in' ? 'clock-in' : 'clock-out'} {timeOf(p.at)}<small>Accuracy {p.accuracyM == null ? 'unknown' : `${Math.round(p.accuracyM)} m`}</small></span>
            <span className={`chip ${p.outcome === 'accepted' ? 'ok' : p.outcome === 'review' ? 'wn' : 'bd'}`}>{p.outcome === 'accepted' ? 'Confirmed' : p.outcome === 'review' ? 'Review' : 'Declined'}</span>
          </div>
        ))}
      </div>
      <p className="mini">Viewing locations is recorded in the audit trail. Only your team’s clock-in and clock-out points are shown, never movements in between.</p>
    </div>
  );
}
