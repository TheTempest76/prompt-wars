import type { Metadata } from 'next';
import { Providers } from './providers';
import './globals.css';

// Set NEXT_PUBLIC_SITE_URL to the real deployed origin before sharing launch
// posts — og:image/twitter:image URLs resolve relative to it, and crawlers
// need an absolute URL, not a relative one. Falls back to Vercel's own
// VERCEL_URL (set automatically on every production/preview deployment) so
// preview URLs get correct OG images without per-preview env var setup.
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3001');
const TITLE = 'Prompt Wars';
const DESCRIPTION =
  'A shared petri dish of luminous, LLM-compiled creatures that keeps living whether or not anyone is watching.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: '/og-image.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['/og-image.png'],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
