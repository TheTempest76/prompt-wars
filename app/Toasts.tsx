'use client';

import { useEffect, useState } from 'react';
import { onToast, type Toast } from './toast';

const TONE_COLOR: Record<Toast['tone'], string> = {
  info: 'var(--rule)',
  good: 'var(--good)',
  bad: 'var(--bad)',
};

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(
    () =>
      onToast(toast => {
        setToasts(cur => [...cur, toast]);
        setTimeout(() => {
          setToasts(cur => cur.filter(t => t.id !== toast.id));
        }, 4500);
      }),
    []
  );

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: '1.25rem',
        transform: 'translateX(-50%)',
        zIndex: 3000,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.4rem',
        alignItems: 'center',
        pointerEvents: 'none',
        width: 'max-content',
        maxWidth: '90vw',
      }}
    >
      {toasts.map(t => (
        <div
          key={t.id}
          style={{
            padding: '0.5rem 0.9rem',
            borderRadius: 8,
            fontSize: '0.85rem',
            color: 'var(--ink)',
            background: 'var(--field-bg)',
            border: `1px solid ${TONE_COLOR[t.tone]}`,
            borderLeft: `3px solid ${TONE_COLOR[t.tone]}`,
            boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
          }}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
