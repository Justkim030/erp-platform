'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { HistoryIcon, HomeIcon, ProfileIcon } from './Icons';

const items = [
  { href: '/home', label: 'Home', Icon: HomeIcon, also: ['/team', '/map', '/sites'] },
  { href: '/history', label: 'History', Icon: HistoryIcon, also: [] as string[] },
  { href: '/profile', label: 'Profile', Icon: ProfileIcon, also: [] as string[] },
];
const active = (path: string, i: (typeof items)[number]) => [i.href, ...i.also].some((p) => path === p || path.startsWith(`${p}/`));

export function Sidebar({ org, roleLabel, name }: { org: string; roleLabel: string; name: string }) {
  const path = usePathname();
  return (
    <aside className="side">
      <b>PresenceHub</b>
      <small>{org} · {roleLabel}</small>
      {items.map((i) => (<Link key={i.href} href={i.href} className={active(path, i) ? 'on' : ''}>{i.label}</Link>))}
      <p className="who">{name}</p>
    </aside>
  );
}

export function TabBar() {
  const path = usePathname();
  return (
    <nav className="tabs" aria-label="Main">
      {items.map((i) => (<Link key={i.href} href={i.href} className={active(path, i) ? 'on' : ''}><i.Icon />{i.label}</Link>))}
    </nav>
  );
}
