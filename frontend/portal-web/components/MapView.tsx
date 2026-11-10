'use client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import { timeOf } from '@/lib/labels';

export type MapPoint = { id: string; userId: string; kind: 'in' | 'out'; at: string; lat: number; lng: number; accuracyM: number | null; outcome: string; reviewDecision?: string | null; fullName?: string; staffNumber?: string };
export type MapSite = { id: string; name: string; lat: number; lng: number; radiusM: number };
type Props = { points?: MapPoint[]; sites?: MapSite[]; pick?: { lat: number; lng: number; radiusM: number } | null; onPick?: (lat: number, lng: number) => void };

const TILE_URL = (process.env.NEXT_PUBLIC_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png')
  .replace(/\{apiKey\}/g, encodeURIComponent(process.env.NEXT_PUBLIC_MAP_TILE_API_KEY ?? ''));
const TILE_ATTRIBUTION = process.env.NEXT_PUBLIC_MAP_TILE_ATTRIBUTION || '© OpenStreetMap contributors';
const FALLBACK_TILE_URL = 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';

const STYLE = {
  in: { color: '#0b3c49', fillColor: '#1b8a8f' },
  out: { color: '#92400e', fillColor: '#f59e0b' },
  bad: { color: '#9a2222', fillColor: '#9a2222' },
};

// Popup content is built from text nodes, never HTML strings, so names and notes cannot inject markup.
function popup(p: MapPoint) {
  const el = document.createElement('div');
  const b = document.createElement('b'); b.textContent = `${p.fullName ?? 'Employee'}${p.staffNumber ? ` · ${p.staffNumber}` : ''} · ID ${p.userId}`;
  const l1 = document.createElement('div'); l1.textContent = `${p.kind === 'in' ? 'Clocked in' : 'Clocked out'} at ${timeOf(p.at)}`;
  const l2 = document.createElement('div'); l2.textContent = `Accuracy ${p.accuracyM == null ? 'unknown' : `${Math.round(p.accuracyM)} m`} · ${p.outcome}${p.reviewDecision ? ` (${p.reviewDecision})` : ''}`;
  el.append(b, l1, l2);
  return el;
}

export default function MapView({ points = [], sites = [], pick, onPick }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map>();
  const layer = useRef<L.LayerGroup>();
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    const m = L.map(el.current!).setView([-0.5388, 37.4596], 13);
    const tileOptions: L.TileLayerOptions = {
      minZoom: 3,
      maxZoom: 19,
      attribution: TILE_ATTRIBUTION,
      referrerPolicy: 'strict-origin-when-cross-origin',
      updateWhenIdle: true,
      keepBuffer: 1,
    };
    const primary = L.tileLayer(TILE_URL, tileOptions);
    let usingFallback = false;
    primary.on('tileerror', () => {
      if (usingFallback) return;
      usingFallback = true;
      m.removeLayer(primary);
      L.tileLayer(FALLBACK_TILE_URL, {
        ...tileOptions,
        attribution: '© OpenStreetMap contributors © CARTO',
      }).addTo(m);
    });
    primary.addTo(m);
    layer.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => pickRef.current?.(e.latlng.lat, e.latlng.lng));
    map.current = m;
    return () => { m.remove(); };
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    sites.forEach((s) => {
      L.circle([s.lat, s.lng], { radius: s.radiusM, color: '#1b8a8f', weight: 2, fillOpacity: 0.08 }).bindTooltip(`${s.name} · ${s.radiusM} m work area`).addTo(g);
      bounds.push([s.lat, s.lng]);
    });
    points.forEach((p) => {
      const bad = p.outcome === 'declined' || p.reviewDecision === 'declined';
      const s = bad ? STYLE.bad : STYLE[p.kind];
      if (p.accuracyM !== null && p.accuracyM > 0) {
        L.circle([p.lat, p.lng], { radius: p.accuracyM, color: s.color, weight: 1, dashArray: '4 4', fillColor: s.fillColor, fillOpacity: 0.08, interactive: false }).addTo(g);
      }
      L.circleMarker([p.lat, p.lng], { radius: 9, weight: 3, color: s.color, fillColor: s.fillColor, fillOpacity: bad ? 0.1 : 0.9, dashArray: p.outcome === 'review' && !p.reviewDecision ? '3 3' : undefined })
        .bindPopup(popup(p)).addTo(g);
      bounds.push([p.lat, p.lng]);
    });
    if (pick) {
      L.circle([pick.lat, pick.lng], { radius: pick.radiusM, color: '#0b3c49', weight: 2, fillOpacity: 0.15 }).addTo(g);
      L.circleMarker([pick.lat, pick.lng], { radius: 6, color: '#0b3c49', fillColor: '#0b3c49', fillOpacity: 1 }).addTo(g);
      m.setView([pick.lat, pick.lng], Math.max(m.getZoom(), 16));
    } else if (bounds.length) {
      m.fitBounds(L.latLngBounds(bounds).pad(0.3), { maxZoom: 17 });
    }
  }, [points, sites, pick]);

  return <div ref={el} className="mapbox" role="application" aria-label="Map of clock-in and clock-out locations" />;
}
