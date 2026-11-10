import { ManagementHome, SupervisorHome, WorkerHome } from '@/components/Homes';
import { requireUser } from '@/lib/session';

export default async function HomePage() {
  const user = await requireUser();
  if (user.role === 'worker') return <WorkerHome user={user} />;
  if (user.role === 'supervisor') return <SupervisorHome user={user} />;
  return <ManagementHome user={user} />;
}
