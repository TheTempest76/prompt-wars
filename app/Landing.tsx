'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../src/module_bindings';

const ENTERED_KEY = 'culture-entered';

// "Returning" = they've clicked into the world before, or this browser already
// holds a SpacetimeDB auth token from a past visit (covers users from before
// this landing page existed).
function hasEnteredBefore(): boolean {
  try {
    if (localStorage.getItem(ENTERED_KEY) === '1') return true;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.endsWith('/auth_token')) return true;
    }
  } catch {
    // localStorage blocked -> treat as a new user, show the landing page.
  }
  return false;
}

// Inline SVG "world" — a wireframe globe. ~1KB, no network, theme-matched.
// The grid drifts slowly (disabled under prefers-reduced-motion) to read as
// a living, turning world.
function Globe() {
  return (
    <svg className="lp-globe" viewBox="0 0 200 200" role="img" aria-label="A turning world">
      <defs>
        <radialGradient id="lpGlow" cx="50%" cy="50%" r="50%">
          <stop offset="60%" stopColor="rgba(55,217,154,0.16)" />
          <stop offset="100%" stopColor="rgba(55,217,154,0)" />
        </radialGradient>
        <radialGradient id="lpSphere" cx="38%" cy="34%" r="75%">
          <stop offset="0%" stopColor="#1c3b34" />
          <stop offset="55%" stopColor="#0e211d" />
          <stop offset="100%" stopColor="#070d0c" />
        </radialGradient>
        <clipPath id="lpClip">
          <circle cx="100" cy="100" r="82" />
        </clipPath>
      </defs>

      <circle cx="100" cy="100" r="98" fill="url(#lpGlow)" />
      <circle cx="100" cy="100" r="82" fill="url(#lpSphere)" stroke="rgba(255,255,255,0.10)" />

      <g clipPath="url(#lpClip)" stroke="rgba(180,225,210,0.22)" strokeWidth="1" fill="none">
        <g className="lp-globe-spin">
          {/* latitudes */}
          <ellipse cx="100" cy="100" rx="82" ry="20" />
          <ellipse cx="100" cy="100" rx="82" ry="46" />
          <ellipse cx="100" cy="100" rx="82" ry="70" />
          <line x1="18" y1="100" x2="182" y2="100" />
          {/* longitudes */}
          <ellipse cx="100" cy="100" rx="20" ry="82" />
          <ellipse cx="100" cy="100" rx="46" ry="82" />
          <ellipse cx="100" cy="100" rx="70" ry="82" />
          <line x1="100" y1="18" x2="100" y2="182" />
        </g>
      </g>

      {/* a few "biome" marks on the surface */}
      <g clipPath="url(#lpClip)">
        <circle cx="72" cy="66" r="3.4" fill="#2f7d5b" />
        <circle cx="132" cy="88" r="3" fill="#3f7fae" />
        <circle cx="96" cy="140" r="3.2" fill="#c07a3a" />
      </g>
    </svg>
  );
}

const CARDS = [
  {
    accent: '#2f7d5b',
    title: 'Write a prompt',
    body: 'Describe a creature in one sentence. An LLM compiles it into a glyph, a temperament, and a habitat.',
    bubble: '“a tiny aggressive hunter”',
  },
  {
    accent: '#3f7fae',
    title: 'Watch it live',
    body: 'It joins a canvas of everyone else’s — hunting food, fleeing predators, growing with every meal.',
    bubble: null,
  },
  {
    accent: '#c07a3a',
    title: 'It persists',
    body: 'The world keeps evolving even when you’re gone. Come back to a petri dish that moved on without you.',
    bubble: null,
  },
];

export function Landing() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const setPlayerEmail = useReducer(reducers.setPlayerEmail);

  const [email, setEmail] = useState('');
  const [updates, setUpdates] = useState(true);
  const [emailState, setEmailState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [emailErr, setEmailErr] = useState<string | null>(null);

  useEffect(() => {
    if (hasEnteredBefore()) router.replace('/world');
    else setReady(true);
  }, [router]);

  const enter = () => {
    try {
      localStorage.setItem(ENTERED_KEY, '1');
    } catch {
      // fine -- they just see the landing again next time
    }
    router.push('/world');
  };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || emailState === 'sending') return;
    setEmailErr(null);
    setEmailState('sending');
    try {
      await setPlayerEmail({ email: email.trim(), source: 'landing_page', optedIn: updates });
      setEmailState('done');
    } catch (err) {
      setEmailErr(err instanceof Error ? err.message : String(err));
      setEmailState('idle');
    }
  };

  // Avoid a flash of the landing page for returning users while the redirect
  // resolves.
  if (!ready) return <div style={{ minHeight: '100vh', background: '#0a0d11' }} />;

  return (
    <div className="lp">
      <style>{`
        .lp {
          min-height: 100vh;
          background:
            radial-gradient(60rem 40rem at 50% -10rem, rgba(47,125,91,0.18), transparent 70%),
            #0a0d11;
          color: #e6e4dd;
          font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          -webkit-font-smoothing: antialiased;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 0 1.25rem 3rem;
        }
        .lp-inner { width: 100%; max-width: 60rem; }
        .lp-hero {
          text-align: center;
          padding: clamp(3rem, 12vh, 7rem) 0 2.5rem;
          position: relative;
        }
        .lp-globe {
          display: block;
          width: min(64vw, 15rem);
          height: auto;
          margin: 0 auto 1.25rem;
        }
        .lp-globe-spin {
          transform-origin: 100px 100px;
          animation: lp-spin 70s linear infinite;
        }
        @keyframes lp-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .lp-globe-spin { animation: none; }
        }
        .lp-hero > * { position: relative; z-index: 1; }
        .lp-title {
          font-size: clamp(2.6rem, 9vw, 4.4rem);
          letter-spacing: -0.02em;
          margin: 0;
          font-weight: 700;
        }
        .lp-tag {
          font-size: clamp(1.05rem, 3.4vw, 1.4rem);
          color: #cfd4cc;
          margin: 0.8rem 0 0;
        }
        .lp-desc {
          max-width: 34rem;
          margin: 1rem auto 0;
          color: #8a938c;
          line-height: 1.6;
          font-size: 0.98rem;
        }
        .lp-cta {
          margin-top: 2rem;
          display: inline-block;
          padding: 0.95rem 1.9rem;
          border-radius: 10px;
          border: none;
          background: #37d99a;
          color: #04120c;
          font-size: 1.05rem;
          font-weight: 700;
          cursor: pointer;
        }
        .lp-cta:hover { filter: brightness(1.06); }
        .lp-cards {
          display: grid;
          grid-template-columns: 1fr;
          gap: 1rem;
          margin: 1rem 0 3rem;
        }
        @media (min-width: 48rem) {
          .lp-cards { grid-template-columns: repeat(3, 1fr); }
        }
        .lp-card {
          background: #11161c;
          border: 1px solid #232a31;
          border-radius: 12px;
          padding: 1.25rem;
        }
        .lp-card h3 { margin: 0.6rem 0 0.35rem; font-size: 1.02rem; }
        .lp-card p { margin: 0; color: #8a938c; font-size: 0.9rem; line-height: 1.55; }
        .lp-dot { width: 0.7rem; height: 0.7rem; border-radius: 50%; display: inline-block; }
        .lp-bubble {
          margin-top: 0.8rem;
          display: inline-block;
          background: rgba(255,255,255,0.04);
          border: 1px solid #232a31;
          border-radius: 999px;
          padding: 0.3rem 0.7rem;
          font-size: 0.82rem;
          color: #cfd4cc;
        }
        .lp-foot {
          width: 100%;
          border-top: 1px solid #232a31;
          padding-top: 2rem;
        }
        .lp-foot h3 { margin: 0 0 0.75rem; font-size: 1rem; }
        .lp-form { display: flex; flex-wrap: wrap; gap: 0.5rem; }
        .lp-input {
          flex: 1 1 16rem;
          min-width: 0;
          padding: 0.6rem 0.75rem;
          border-radius: 8px;
          border: 1px solid #2c343c;
          background: #0d1216;
          color: inherit;
          font: inherit;
          font-size: 0.95rem;
        }
        .lp-input:focus-visible { outline: 2px solid #37d99a; outline-offset: 1px; }
        .lp-submit {
          padding: 0.6rem 1.1rem;
          border-radius: 8px;
          border: 1px solid #2c343c;
          background: transparent;
          color: inherit;
          font: inherit;
          font-weight: 600;
          cursor: pointer;
        }
        .lp-submit:hover:not(:disabled) { border-color: #37d99a; color: #37d99a; }
        .lp-submit:disabled { opacity: 0.5; cursor: not-allowed; }
        .lp-check {
          display: flex; align-items: flex-start; gap: 0.5rem;
          margin-top: 0.75rem; font-size: 0.85rem; color: #8a938c;
        }
        .lp-links { margin-top: 1.5rem; font-size: 0.85rem; color: #6f776f; }
        .lp-links a { color: #8a938c; text-decoration: underline; }
        .lp-note { margin-top: 0.75rem; font-size: 0.85rem; }
      `}</style>

      <div className="lp-inner">
        <section className="lp-hero">
          <Globe />
          <h1 className="lp-title">Culture</h1>
          <p className="lp-tag">Write a creature. Watch it evolve forever.</p>
          <p className="lp-desc">
            Spawn organisms with AI-generated behaviour. They eat, grow, reproduce, and
            die in a living world that runs 24/7 — with or without you.
          </p>
          <div>
            <button className="lp-cta" onClick={enter}>
              Enter the petri dish
            </button>
          </div>
        </section>

        <section className="lp-cards">
          {CARDS.map(c => (
            <div className="lp-card" key={c.title}>
              <span className="lp-dot" style={{ background: c.accent }} />
              <h3>{c.title}</h3>
              <p>{c.body}</p>
              {c.bubble && <span className="lp-bubble">{c.bubble}</span>}
            </div>
          ))}
        </section>

        <footer className="lp-foot">
          <h3>Stay updated on your creatures</h3>
          {emailState === 'done' ? (
            <p className="lp-note" style={{ color: '#37d99a' }}>
              Check your inbox (or spam folder).
            </p>
          ) : (
            <form className="lp-form" onSubmit={submitEmail}>
              <input
                className="lp-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                aria-label="Email address"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
              <button
                className="lp-submit"
                type="submit"
                disabled={!email.trim() || emailState === 'sending'}
              >
                {emailState === 'sending' ? 'Signing up…' : 'Sign me up'}
              </button>
            </form>
          )}

          {emailState !== 'done' && (
            <label className="lp-check">
              <input
                type="checkbox"
                checked={updates}
                onChange={e => setUpdates(e.target.checked)}
                style={{ marginTop: '0.15rem' }}
              />
              Send me updates when my creatures reproduce or use powerups.
            </label>
          )}
          {emailErr && (
            <p className="lp-note" style={{ color: '#d9776a' }}>
              {emailErr}
            </p>
          )}
          <p className="lp-note" style={{ color: '#6f776f' }}>
            Optional — the button above lets you in either way.
          </p>

          <p className="lp-links">
            <a href="https://x.com" target="_blank" rel="noreferrer">
              Twitter
            </a>
            {'  ·  '}
            <a href="https://discord.com" target="_blank" rel="noreferrer">
              Discord
            </a>
          </p>
        </footer>
      </div>
    </div>
  );
}
