'use client';
import dynamic from 'next/dynamic';

// The map library is only downloaded on pages that show a map.
export const Map = dynamic(() => import('./MapView'), {
  ssr: false,
  loading: () => <div className="mapbox" style={{ display: 'grid', placeItems: 'center', color: '#5c6f76' }}>Loading map…</div>,
});
