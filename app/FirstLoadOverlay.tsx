'use client';

import { useEffect, useState } from 'react';

const SEEN_KEY = 'prompt-wars-seen-intro';

// Shows once per browser (localStorage-gated). Static images only —
// public/hero.png and public/wordmark.png, both placeholders, see README.
export function FirstLoadOverlay() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    try {
      if (localStorage.getItem(SEEN_KEY)) setVisible(false);
    } catch {
      // localStorage unavailable (private mode, etc.) — just show it every
      // time; harmless, not worth a fallback for.
    }
  }, []);

  const dismiss = () => {
    setVisible(false);
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // see above
    }
  };

  if (!visible) return null;

  return (
    <div
      onClick={dismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: '#05070c',
        backgroundImage: 'url(/hero.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-end',
        cursor: 'pointer',
        padding: '2rem',
        transition: 'opacity 0.2s ease-out',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a plain static image, next/image's optimization pipeline is unneeded overhead here */}
      <img
        src="/wordmark.png"
        alt="Prompt Wars"
        style={{ maxWidth: '80%', width: 320, height: 'auto', marginBottom: '2rem' }}
      />
      <p style={{ color: 'white', opacity: 0.8, fontFamily: 'system-ui, sans-serif', margin: 0 }}>
        Tap anywhere to enter
      </p>
    </div>
  );
}
