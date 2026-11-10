export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="authwrap">
      <aside className="brand">
        <b>PresenceHub</b>
        <p style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.35 }}>Accurate attendance, verified at the point of entry.</p>
        <p style={{ color: '#cfe3e7' }}>One system for workers, supervisors and management, built on fair, privacy-respecting verification.</p>
      </aside>
      <main className="authmain"><div className="authform">{children}</div></main>
    </div>
  );
}
