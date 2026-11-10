import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'PresenceHub', description: 'Verified workforce attendance' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0b3c49' };

export const dynamic = 'force-dynamic'; // every page is rendered per request so each response carries its own CSP nonce

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
