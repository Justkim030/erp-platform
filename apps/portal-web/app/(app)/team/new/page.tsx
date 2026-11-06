import { AddEmployee } from '@/components/Team';
import { requireUser, svc } from '@/lib/session';

export default async function NewEmployeePage() {
  const user = await requireUser(['supervisor', 'management', 'admin']);
  const users = user.role === 'supervisor' ? [] : (await svc<any[]>('identity', '/v1/users')) ?? [];
  return (
    <div className="stack">
      <div><p className="eb">Add to your team</p><h1 className="h">New employee</h1></div>
      <AddEmployee role={user.role} supervisors={users.filter((u) => u.role === 'supervisor')} />
    </div>
  );
}
