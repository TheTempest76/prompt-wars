'use client';

import { useEffect, useState } from 'react';
import { unlockSfx } from './sfx';

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
    // This click is the user gesture that lets WebAudio start — take it.
    unlockSfx();
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
      {/* bottom scrim so the wordmark/hint stay legible over any hero image */}
      <div
        style={{
          position: 'absolute',
          inset: 'auto 0 0 0',
          height: '45%',
          background: 'linear-gradient(to top, rgba(5,7,12,0.85), transparent)',
          pointerEvents: 'none',
        }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- a plain static image, next/image's optimization pipeline is unneeded overhead here */}
      <img
        src="/wordmark.png"
        alt="Prompt Wars"
        style={{
          maxWidth: '80%',
          width: 320,
          height: 'auto',
          marginBottom: '1.5rem',
          position: 'relative',
        }}
      />
      <p
        style={{
          color: 'white',
          opacity: 0.75,
          fontFamily: 'system-ui, sans-serif',
          fontSize: '0.8rem',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          margin: 0,
          position: 'relative',
        }}
      >
        Tap anywhere to enter
      </p>
    </div>
  );
}
