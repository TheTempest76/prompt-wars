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
    <div style={{ marginTop: '2rem', borderTop: '1px solid #ccc', paddingTop: '1rem' }}>
      <h2>Spawn a creature</h2>
      <form onSubmit={submit} style={{ marginBottom: '0.5rem' }}>
        <input
          type="text"
          placeholder="a tiny fast red hummingbird that flees everything"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          disabled={!connected || status === 'spawning'}
          style={{ padding: '0.5rem', marginRight: '0.5rem', width: '22rem' }}
        />
        <button type="submit" disabled={!connected || status === 'spawning'}>
          {status === 'spawning' ? 'Compiling...' : 'Spawn'}
        </button>
      </form>
      {summary && <p>{summary}</p>}
    </div>
  );
}
