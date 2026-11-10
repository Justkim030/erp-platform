'use client';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

type Person = { id: string; fullName: string; staffNumber: string; role: string; status: string };
type Progress = { actorId: string; status: string; note: string | null; createdAt: string };
type Task = {
  id: string; title: string; description: string | null; priority: string; due_date: string | null;
  assigned_to: string; status: string; progress: Progress[];
};
type Role = 'worker' | 'supervisor' | 'management' | 'admin';
const transitions: Record<string, string[]> = {
  assigned: ['in_progress', 'completed', 'blocked', 'cancelled'],
  in_progress: ['completed', 'blocked', 'cancelled'],
  blocked: ['in_progress', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};
const label = (value: string) => value.replace('_', ' ');

async function responseError(res: Response) {
  const data = await res.json().catch(() => ({}));
  return typeof data.message === 'string' ? data.message : 'The task could not be updated.';
}

function TaskActions({ task, users, editable }: { task: Task; users: Person[]; editable: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options = transitions[task.status] ?? [];
  const assignee = users.find((person) => person.id === task.assigned_to);

  async function update(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true); setError('');
    const res = await fetch(`/api/svc/attendance/v1/tasks/${task.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: String(form.get('title')).trim(),
        description: String(form.get('description')).trim() || null,
        priority: String(form.get('priority')),
        dueDate: String(form.get('dueDate')) || null,
        assignedTo: String(form.get('assignedTo')),
      }),
    });
    setBusy(false);
    if (!res.ok) { setError(await responseError(res)); return; }
    setEditing(false); router.refresh();
  }

  async function progress(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true); setError('');
    const res = await fetch(`/api/svc/attendance/v1/tasks/${task.id}/progress`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: String(form.get('status')), note: String(form.get('note')).trim() || undefined }),
    });
    setBusy(false);
    if (!res.ok) { setError(await responseError(res)); return; }
    router.refresh();
  }

  return (
    <div className="stack">
      {assignee && <small>Assigned to {assignee.fullName} · {assignee.staffNumber}</small>}
      {editing ? (
        <form className="stack" onSubmit={update}>
          <label>Title<input name="title" required minLength={3} maxLength={160} defaultValue={task.title} /></label>
          <label>Description<textarea name="description" maxLength={4000} defaultValue={task.description ?? ''} /></label>
          <div className="grid2">
            <label>Priority<select name="priority" defaultValue={task.priority}>{['low', 'normal', 'high', 'urgent'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label>Due date<input name="dueDate" type="date" defaultValue={task.due_date?.slice(0, 10) ?? ''} /></label>
          </div>
          <label>Assignee<select name="assignedTo" required defaultValue={task.assigned_to}>{users.map((person) => <option key={person.id} value={person.id}>{person.fullName} · {person.staffNumber}</option>)}</select></label>
          {error && <div className="err" role="alert">{error}</div>}
          <div className="actions">
            <button className="btn sm" disabled={busy}>Save changes</button>
            <button className="btn sm alt" type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <span className="chip wn">{label(task.status)}</span>
          {editable && <button className="link" type="button" onClick={() => setEditing(true)}>Edit task</button>}
        </div>
      )}
      {!editing && options.length > 0 && (
        <form className="grid2" onSubmit={progress}>
          <label>Update progress<select name="status" defaultValue={options[0]}>{options.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></label>
          <label>Note (optional)<input name="note" maxLength={2000} placeholder="Progress update" /></label>
          <button className="btn sm" disabled={busy}>Save progress</button>
        </form>
      )}
      {!editing && error && <div className="err" role="alert">{error}</div>}
      {task.progress?.length > 0 && <div className="stack">
        <small>Progress history</small>
        {task.progress.map((entry, index) => (
          <small key={`${entry.createdAt}-${index}`}>{label(entry.status)} · {new Date(entry.createdAt).toLocaleString()}{entry.note ? ` · ${entry.note}` : ''}</small>
        ))}
      </div>}
    </div>
  );
}

export function TasksBoard({ role, tasks, users }: { role: Role; tasks: Task[]; users: Person[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canAssign = role === 'supervisor' || role === 'management' || role === 'admin';
  const workers = users.filter((person) => person.role === 'worker' && person.status === 'active');

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formElement = e.currentTarget;
    const form = new FormData(formElement);
    setBusy(true); setError('');
    const res = await fetch('/api/svc/attendance/v1/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: String(form.get('title')).trim(), description: String(form.get('description')).trim() || undefined,
        priority: String(form.get('priority')), dueDate: String(form.get('dueDate')) || undefined,
        assignedTo: String(form.get('assignedTo')),
      }),
    });
    setBusy(false);
    if (!res.ok) { setError(await responseError(res)); return; }
    formElement.reset(); router.refresh();
  }

  return (
    <div className="stack">
      {canAssign && <form className="card stack" onSubmit={create}>
        <b>Assign a task</b>
        {workers.length === 0 ? <p className="sub">No active workers are available for assignment.</p> : <>
          <label>Task title<input name="title" required minLength={3} maxLength={160} /></label>
          <label>Description (optional)<textarea name="description" maxLength={4000} /></label>
          <div className="grid2">
            <label>Priority<select name="priority" defaultValue="normal">{['low', 'normal', 'high', 'urgent'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label>Due date (optional)<input name="dueDate" type="date" /></label>
          </div>
          <label>Assign to<select name="assignedTo" required defaultValue=""><option value="" disabled>Select a worker</option>{workers.map((person) => <option key={person.id} value={person.id}>{person.fullName} · {person.staffNumber}</option>)}</select></label>
          {error && <div className="err" role="alert">{error}</div>}
          <button className="btn" disabled={busy}>{busy ? 'Assigning…' : 'Assign task'}</button>
        </>}
      </form>}
      <div className="card stack">
        <b>{role === 'worker' ? 'Your assigned tasks' : role === 'supervisor' ? 'Your team tasks' : 'Organisation tasks'}</b>
        {!tasks.length && <p className="sub">No tasks are available in this view.</p>}
        {tasks.map((task) => (
          <div className="activity-editor stack" key={task.id}>
            <div className="actions" style={{ justifyContent: 'space-between' }}>
              <b>{task.title}</b><span className="chip wn">{task.priority}</span>
            </div>
            {task.description && <p className="sub">{task.description}</p>}
            {task.due_date && <small>Due {new Date(`${task.due_date.slice(0, 10)}T00:00:00`).toLocaleDateString()}</small>}
            <TaskActions task={task} users={users} editable={canAssign} />
          </div>
        ))}
      </div>
    </div>
  );
}
