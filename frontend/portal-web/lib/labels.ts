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

const TZ = process.env.NEXT_PUBLIC_ORG_TIMEZONE || 'Africa/Nairobi';
export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const dateOf = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
export const duration = (mins: number | null) => (mins == null ? '' : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`);
export const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
