import { TeamMap } from '@/components/TeamMap';
import { requireUser } from '@/lib/session';

export default async function MapPage() {
  await requireUser(['supervisor', 'management', 'admin']);
  return (
    <div className="stack">
      <div><p className="eb">Clock-in and clock-out locations</p><h1 className="h">Locations map</h1></div>
      <TeamMap />
    </div>
  );
}
