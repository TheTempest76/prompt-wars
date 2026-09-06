'use client';

import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../src/module_bindings';

// A simple infinite CSS marquee of the real names people have signed with in
// the guestbook (person table). Pure CSS animation -- no JS ticker.
export function NamesMarquee() {
  const [people] = useTable(tables.person);

  const names = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of people) {
      const n = p.name.trim();
      if (n && !seen.has(n.toLowerCase())) {
        seen.add(n.toLowerCase());
        out.push(n);
      }
    }
    return out;
  }, [people]);

  if (names.length === 0) return null;

  // Duplicate the list so translateX(-50%) loops seamlessly.
  const row = [...names, ...names];

  return (
    <section className="nm" aria-label="People in this world">
      <style>{`
        .nm { margin-top: 3rem; border-top: 1px solid var(--rule); padding-top: 1.25rem; }
        .nm-label {
          font-size: 0.72rem; font-weight: 600; letter-spacing: 0.09em;
          text-transform: uppercase; color: var(--muted); margin: 0 0 0.75rem;
        }
        .nm-viewport {
          overflow: hidden;
          -webkit-mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
          mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
        }
        .nm-track {
          display: flex;
          width: max-content;
          gap: 1.75rem;
          animation: nm-scroll 45s linear infinite;
        }
        .nm-viewport:hover .nm-track { animation-play-state: paused; }
        .nm-name {
          font-family: var(--mono);
          font-size: 0.9rem;
          color: var(--ink);
          white-space: nowrap;
          opacity: 0.85;
        }
        .nm-name::before { content: "◦"; color: var(--muted); margin-right: 1.75rem; }
        @keyframes nm-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        @media (prefers-reduced-motion: reduce) {
          .nm-track { animation: none; }
          .nm-viewport { overflow-x: auto; }
        }
      `}</style>
      <p className="nm-label">
        {names.length} {names.length === 1 ? 'person has' : 'people have'} signed in
      </p>
      <div className="nm-viewport">
        <div className="nm-track">
          {row.map((n, i) => (
            <span className="nm-name" key={i}>
              {n}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
