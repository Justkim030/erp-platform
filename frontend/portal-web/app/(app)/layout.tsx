import { redirect } from 'next/navigation';
import { Sidebar, TabBar } from '@/components/Nav';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';
const ROLE_LABEL = { worker: 'Worker', supervisor: 'Supervisor', management: 'Management', admin: 'Administrator' } as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect('/login');
  return (
    <div className="shell">
      <Sidebar org={user.tenant.name} roleLabel={ROLE_LABEL[user.role]} name={user.fullName} role={user.role} />
      <div className="content">{children}</div>
      <TabBar role={user.role} />
    </div>
  );
}
