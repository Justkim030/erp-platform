export type Reading = { lat: number; lng: number; accuracy: number; capturedAt: string };

/** One fresh reading, requested only when the worker taps Clock in or Clock out. Nothing is tracked in between. */
export function getReading(): Promise<Reading> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return reject(new Error('This browser cannot share its location. Ask your supervisor to review your entry.'));
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, capturedAt: new Date(p.timestamp).toISOString() }),
      (e) => reject(new Error(
        e.code === 1 ? 'Location access is switched off. Allow location for this site in your browser settings, then try again.'
        : e.code === 3 ? 'Finding your location took too long. Move to an open area and try again.'
        : 'Your location could not be read. Try again.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });
}
