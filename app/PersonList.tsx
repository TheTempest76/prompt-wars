'use client';

import { useState, useEffect } from 'react';
import { tables, reducers } from '../src/module_bindings';
import { useSpacetimeDB, useTable, useReducer } from 'spacetimedb/react';
import type { PersonData } from '../lib/spacetimedb-server';

interface PersonListProps {
  initialPeople: PersonData[];
}

export function PersonList({ initialPeople }: PersonListProps) {
  const [name, setName] = useState('');
  const [isHydrated, setIsHydrated] = useState(false);

  const conn = useSpacetimeDB();
  const { isActive: connected } = conn;

  // Subscribe to all people in the database
  // useTable returns [rows, isLoading] tuple
  const [people, isLoading] = useTable(tables.person);

  const addReducer = useReducer(reducers.add);

  // Once connected and loaded, we're hydrated with real-time data
  useEffect(() => {
    if (connected && !isLoading) {
      setIsHydrated(true);
    }
  }, [connected, isLoading]);

  // Use server-rendered data until client is hydrated with real-time data
  const displayPeople = isHydrated ? people : initialPeople;

  const addPerson = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !connected) return;

    // Call the add reducer with object syntax
    addReducer({ name: name });
    setName('');
  };

  return (
    <section className="panel" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <span className="eyebrow">
          Guestbook · {displayPeople.length} {displayPeople.length === 1 ? 'name' : 'names'}
        </span>
        <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
          <span
            className="status-dot"
            style={{ background: connected ? 'var(--good)' : 'var(--bad)', marginRight: '0.4rem' }}
          />
          {connected ? 'connected' : 'connecting…'}
        </span>
      </div>

      <form
        onSubmit={addPerson}
        style={{ display: 'flex', gap: '0.5rem', margin: '0.65rem 0 0.9rem', flexWrap: 'wrap' }}
      >
        <input
          className="field"
          type="text"
          placeholder="Sign in — your initials label your creatures"
          value={name}
          onChange={e => setName(e.target.value)}
          style={{ flex: '1 1 18rem', minWidth: 0 }}
          disabled={!connected}
        />
        <button className="btn" type="submit" disabled={!connected || !name.trim()}>
          Sign
        </button>
      </form>

      {displayPeople.length === 0 ? (
        <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>No one has signed in yet.</p>
      ) : (
        <p style={{ fontSize: '0.9rem', color: 'var(--muted)', lineHeight: 1.7 }}>
          {displayPeople.map((person, index) => (
            <span key={index}>
              {index > 0 && ' · '}
              <span style={{ color: 'var(--ink)' }}>{person.name}</span>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
