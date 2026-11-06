import { SiteEditor } from '@/components/SiteEditor';
import { requireUser, svc } from '@/lib/session';

export default async function SitesPage() {
  await requireUser(['management', 'admin']);
  const sites = await svc<any[]>('attendance', '/v1/sites');
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div><p className="eb">Where people clock in</p><h1 className="h">Sites and rules</h1></div>
      {sites ? <SiteEditor sites={sites} /> : <p className="notice">Sites are unavailable right now.</p>}
    </div>
  );
}
