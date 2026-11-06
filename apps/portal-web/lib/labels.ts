export const REASONS: Record<string, string> = {
  outside_site: 'Outside the site boundary',
  uncertain_boundary: 'Close to the boundary',
  low_accuracy: 'Low location accuracy',
  unrealistic_accuracy: 'Unusual accuracy value',
  stale_reading: 'Old location reading',
  impossible_travel: 'Travel speed not plausible',
  identical_coordinates: 'Identical coordinates repeated',
  network_not_recognised: 'Not on the staff network',
  review_requested: 'Worker asked for a review',
  location_unavailable: 'Location was not shared',
};
export const reasonText = (r: string) => REASONS[r] ?? r;

const TZ = 'Africa/Nairobi';
export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const dateOf = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
export const duration = (mins: number | null) => (mins == null ? '' : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`);
export const todayLocal = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
export const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
