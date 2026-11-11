import Link from 'next/link';

const RETENTION_DAYS = process.env.NEXT_PUBLIC_RETENTION_DAYS ?? '90';

const H2 = ({ children, id }: { children: React.ReactNode; id?: string }) => <h2 id={id} style={{ fontSize: 17, fontWeight: 800, marginTop: 24 }}>{children}</h2>;
const P = ({ children }: { children: React.ReactNode }) => <p style={{ marginTop: 10, fontSize: 14, lineHeight: 1.6 }}>{children}</p>;

export const metadata = { title: 'Privacy Policy â€” PresenceHub' };

export default function PrivacyPage() {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '32px 20px 64px' }}>
      <h1 style={{ fontSize: 25, fontWeight: 800 }}>Privacy Policy</h1>
      <p style={{ color: 'var(--mut)', fontSize: 13, marginTop: 4 }}>Last updated: 11 November 2026</p>

      <P>
        PresenceHub is operated by your employer (the &ldquo;Organisation&rdquo;) using the PresenceHub
        platform (&ldquo;we&rdquo;, &ldquo;the platform&rdquo;). Your employer is the <b>data controller</b>: they decide
        why and how your information is used. Questions or requests about your data go to your
        employer&rsquo;s contact for attendance matters (see <Link href="#rights">Your rights</Link> below).
      </P>

      <H2>What we collect and why</H2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 10 }} role="table">
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--line)' }}>
            <th style={{ padding: '8px 8px 8px 0' }}>Data</th>
            <th style={{ padding: 8 }}>Purpose</th>
            <th style={{ padding: 8 }}>When</th>
          </tr>
        </thead>
        <tbody>
          {[
            ['Staff number, full name, role, phone (optional)', 'Identifying you and letting your supervisor manage attendance', 'When your supervisor adds you'],
            ['Activation codes', 'One-time proof you are the right person setting up access', 'At onboarding; codes expire in 7 days and are stored hashed'],
            ['PIN or password', 'Proving it is you at sign-in', 'Stored only as an irreversible Argon2id hash, never readable'],
            ['Passkey credential (optional, workers)', 'Confirming clock-ins on your own device', 'Only if you register one in Profile; only the public key is stored'],
            ['Location reading â€” one-time per clock event', 'Verifying you are at the work site when you clock in or out', 'Only when you tap Clock in/out and allow the browser prompt'],
            ['Location accuracy value', 'Deciding whether the reading is reliable', 'With each reading'],
            ['Clock-in/out times, site, outcome, work report', 'Your attendance record', 'With each clock event'],
            ['IP address, device/browser type', 'Verifying the staff network where required, and security auditing', 'With each request'],
            ['Audit records of who viewed what', 'Protecting you: every view of your clock locations is recorded', 'Whenever a supervisor opens the map'],
          ].map(([d, p, w]) => (
            <tr key={d as string} style={{ borderBottom: '1px solid var(--line)' }}>
              <td style={{ padding: '10px 8px 10px 0' }}><b>{d}</b></td>
              <td style={{ padding: 10 }}>{p}</td>
              <td style={{ padding: 10 }}>{w}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <H2>What we deliberately do NOT do</H2>
      <ul style={{ marginTop: 10, paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
        <li><b>No background tracking.</b> Location is read once, when you tap Clock in/out, with an explicit browser prompt you control. Nothing is collected between clock events, while you move, or while the app is closed.</li>
        <li><b>No movement history.</b> Your own history shows paired clock-in/out times and sites â€” not your movements.</li>
        <li><b>Exact coordinates are erased automatically</b> after the retention period shown in your Profile (default {RETENTION_DAYS} days). The attendance outcome and time are kept; the precise point is not.</li>
        <li><b>No sale of data, no advertising, no third-party trackers.</b> The app loads map images from a tile provider, which sees only standard web requests for map imagery.</li>
        <li><b>No shared secrets.</b> Nobody â€” not your supervisor, not the platform operator â€” can see or retrieve your PIN or password.</li>
      </ul>

      <H2>How decisions about your attendance are made</H2>
      <P>
        Clock-in and clock-out acceptance is <b>decided by the server</b>, not by your phone: it
        compares your one-time location reading with the site boundary and its accuracy, optionally
        the staff network address, and plausibility rules. Possible outcomes:
      </P>
      <ul style={{ marginTop: 8, paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
        <li><b>Accepted</b> â€” recorded as worked.</li>
        <li><b>Recorded for review</b> â€” something was uncertain (for example, low GPS accuracy or an old reading). A supervisor â€” usually yours â€” decides, and the decision is recorded.</li>
        <li><b>Declined</b> â€” recorded but not counted as worked, with plain guidance on what to do.</li>
      </ul>
      <P>
        A <b>declined entry is never hidden from you</b>; you can always ask for a supervisor review.
        If you were genuinely at work, the review corrects the record with an audited correction
        entry â€” the original event is preserved, never silently edited.
      </P>

      <H2 id="rights">Your rights</H2>
      <P>
        You can, at any time, through your supervisor or your Organisation&rsquo;s attendance contact:
      </P>
      <ol style={{ marginTop: 8, paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
        <li><b>See your data</b> â€” what is held about you, including your clock history and work reports.</li>
        <li><b>Correct your data</b> â€” wrong name, phone number, or staff record.</li>
        <li><b>Delete your data</b> â€” when you leave the Organisation. Exact location points are already erased automatically after the retention period; other records are handled per your employer&rsquo;s retention policy and employment law.</li>
        <li><b>Know who looked</b> â€” every view of your clock locations by a supervisor or manager is recorded in an audit trail.</li>
      </ol>
      <P>
        This policy and the platform&rsquo;s design align with the <b>Kenya Data Protection Act, 2019</b>
        and, where applicable, GDPR principles: purpose limitation, data minimisation, storage
        limitation, and transparency.
      </P>

      <H2>Security measures</H2>
      <ul style={{ marginTop: 10, paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
        <li>Passwords and PINs: Argon2id hashing (industry standard), never stored readably.</li>
        <li>Sign-in sessions: short-lived access tokens with rotating refresh tokens; reuse of an old token ends the whole session family (theft protection).</li>
        <li>Transport: all traffic between your browser and the service is encrypted (HTTPS).</li>
        <li>Clock-in confirmation: optional passkeys (fingerprint, face, device PIN) so only you can clock you in.</li>
        <li>Access control: workers see their own data; supervisors see their assigned team; management sees the organisation. Every administrative action is audited.</li>
      </ul>

      <H2>Changes to this policy</H2>
      <P>
        Material changes will be announced by your employer before they take effect. The version
        date at the top always reflects the current policy.
      </P>

      <p style={{ marginTop: 32 }}>
        <Link href="/login">&larr; Back to sign-in</Link>
      </p>
    </div>
  );
}
