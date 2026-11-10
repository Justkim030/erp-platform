import { TasksBoard } from '@/components/TasksBoard';
import { requireUser, svc } from '@/lib/session';

type Person = { id: string; fullName: string; staffNumber: string; role: string; status: string };
type Task = { id: string; title: string; description: string | null; priority: string; due_date: string | null; assigned_to: string; status: string; progress: any[] };

export default async function TasksPage() {
  const user = await requireUser();
  const canAssign = user.role === 'supervisor' || user.role === 'management' || user.role === 'admin';
  const [tasks, users] = await Promise.all([
    svc<Task[]>('attendance', '/v1/tasks'),
    canAssign ? svc<Person[]>('identity', '/v1/users') : Promise.resolve([]),
  ]);
  return (
    <div className="stack">
      <div><p className="eb">Assigned work and progress</p><h1 className="h">Tasks</h1></div>
      {tasks === null
        ? <p className="notice">Tasks are unavailable right now. Please try again shortly.</p>
        : <TasksBoard role={user.role} tasks={tasks} users={(users ?? []).filter((person) => person.id !== user.id)} />}
    </div>
  );
}
