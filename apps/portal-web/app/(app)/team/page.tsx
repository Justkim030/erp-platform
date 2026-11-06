import Link from 'next/link';
import { TeamList } from '@/components/Team';
import { requireUser, svc } from '@/lib/session';

export default async function TeamPage() {
  const user = await requireUser(['supervisor', 'management', 'admin']);
  const users = await svc<any[]>('identity', '/v1/users');
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <div><p className="eb">{user.role === 'supervisor' ? 'Your team' : 'Everyone in the organisation'}</p><h1 className="h">Team</h1></div>
      <div className="actions"><Link className="btn sm" href="/team/new">Add employee</Link></div>
      {users ? <TeamList users={users.filter((u) => u.id !== user.id)} canReset /> : <p className="notice">The team list is unavailable right now.</p>}
    </div>
  );
}
