'use client';

import { useState } from 'react';
import { useProcedure, useSpacetimeDB } from 'spacetimedb/react';
import { procedures } from '../src/module_bindings';

export function SpawnCreature() {
  const { isActive: connected } = useSpacetimeDB();
  const spawnFromPrompt = useProcedure(procedures.spawnFromPrompt);
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<'idle' | 'spawning'>('idle');
  const [summary, setSummary] = useState<string | null>(null);

  const busy = status === 'spawning';
  const canSubmit = connected && !busy && prompt.trim().length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim() || !connected) return;
    setStatus('spawning');
    setSummary(null);
    try {
      // Procedures return a value directly to the caller — unlike a
      // reducer, no separate subscription round-trip is needed to see
      // the compiled result.
      const result = await spawnFromPrompt({ prompt: prompt.trim() });
      setSummary(result.summary);
      setPrompt('');
    } catch (err) {
      setSummary(`Spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStatus('idle');
    }
  };

  return (
    <section className="panel">
      <span className="eyebrow">Spawn a creature</span>
      <p style={{ margin: '0.25rem 0 0.75rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
        Describe one in plain language — an LLM compiles it into a glyph, behavior, and habitat.
      </p>

      <form
        onSubmit={submit}
        style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'stretch' }}
      >
        <input
          className="field"
          type="text"
          placeholder="a tiny fast red hummingbird that flees everything"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          disabled={!connected || busy}
          aria-label="Creature description"
          style={{ flex: '1 1 24rem', minWidth: 0 }}
        />
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          {busy ? 'Compiling…' : 'Spawn'}
        </button>
      </form>

      {!connected && (
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.8rem', color: 'var(--muted)' }}>
          Connecting to the world…
        </p>
      )}
      {summary && <p style={{ margin: '0.6rem 0 0', fontSize: '0.9rem' }}>{summary}</p>}
    </section>
  );
}
