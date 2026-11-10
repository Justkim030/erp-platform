'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { HistoryIcon, HomeIcon, ProfileIcon } from './Icons';

type Role = 'worker' | 'supervisor' | 'management' | 'admin';
const itemsFor = (role: Role) => [
  { href: '/home', label: 'Home', Icon: HomeIcon, also: ['/team', '/map', '/sites'] },
  { href: '/history', label: 'History', Icon: HistoryIcon, also: [] as string[] },
  { href: '/tasks', label: 'Tasks', Icon: HistoryIcon, also: [] as string[] },
  { href: '/reports', label: role === 'worker' ? 'My reports' : role === 'supervisor' ? 'Team reports' : 'Insights', Icon: HistoryIcon, also: [] as string[] },
  { href: '/profile', label: 'Profile', Icon: ProfileIcon, also: [] as string[] },
];
const active = (path: string, i: ReturnType<typeof itemsFor>[number]) => [i.href, ...i.also].some((p) => path === p || path.startsWith(`${p}/`));

export function Sidebar({ org, roleLabel, name, role }: { org: string; roleLabel: string; name: string; role: Role }) {
  const path = usePathname();
  return (
    <aside className="side">
      <b>PresenceHub</b>
      <small>{org} · {roleLabel}</small>
      {itemsFor(role).map((i) => (<Link key={i.href} href={i.href} className={active(path, i) ? 'on' : ''}>{i.label}</Link>))}
      <p className="who">{name}</p>
    </aside>
  );
}

export function TabBar({ role }: { role: Role }) {
  const path = usePathname();
  return (
    <nav className="tabs" aria-label="Main">
      {itemsFor(role).map((i) => (<Link key={i.href} href={i.href} className={active(path, i) ? 'on' : ''}><i.Icon />{i.label}</Link>))}
    </nav>
  );
}
