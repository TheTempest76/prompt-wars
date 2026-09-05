'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../src/module_bindings';
import { WorldCanvas } from './WorldCanvas';
import { isSfxMuted, playFoodPickup, setSfxMuted, unlockSfx } from './sfx';

function formatTime(micros: bigint): string {
  return new Date(Number(micros / 1000n)).toLocaleTimeString();
}

export function WorldView() {
  // All four are live subscriptions — this whole view repaints itself
  // whenever the scheduled `tick` reducer commits, no polling. Fetched here
  // (not inside WorldCanvas) so there's exactly one subscription per table,
  // not one per component that wants the data.
  const [configs] = useTable(tables.world_config);
  const [creatures] = useTable(tables.creature);
  // A food row is deleted the moment a creature eats it — blip on that.
  // playFoodPickup() rate-limits itself, so a same-tick eating spree is one
  // sound, not a burst.
  const [foodRows] = useTable(tables.food, { onDelete: () => playFoodPickup() });
  const [events] = useTable(tables.event_log);
  const [terrainRows] = useTable(tables.terrain);
  // Small guestbook table -- a second subscription alongside PersonList's own
  // is negligible here, unlike creature/food (see ARCHITECTURE.md).
  const [people] = useTable(tables.person);

  // Read once on mount, not during render — isSfxMuted() touches localStorage
  // and would mismatch the server-rendered markup.
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    setMuted(isSfxMuted());
    // Returning visitors skip the intro overlay, so unlock audio on their
    // first interaction with the page instead.
    const onFirstGesture = () => unlockSfx();
    window.addEventListener('pointerdown', onFirstGesture, { once: true });
    return () => window.removeEventListener('pointerdown', onFirstGesture);
  }, []);
  const toggleMuted = () => {
    const next = !muted;
    setMuted(next);
    setSfxMuted(next);
    if (!next) unlockSfx();
  };

  const config = configs[0];
  const gridSize = config ? Number(config.gridSize) : 0;
  const terrainCells = terrainRows[0]?.cells;
  const tickIntervalMs = config ? Number(config.tickIntervalMicros / 1000n) : 2000;

  // Profile-name feature: each identity's latest submitted name, reduced to
  // initials, keyed by Identity.toHexString() so WorldCanvas can label a
  // creature with whoever owns it.
  const ownerInitials = useMemo(() => {
    const latest = new Map<string, { name: string; createdAt: bigint }>();
    for (const p of people) {
      if (!p.owner) continue;
      const key = p.owner.toHexString();
      const createdAt = p.createdAt.microsSinceUnixEpoch;
      const existing = latest.get(key);
      if (!existing || createdAt > existing.createdAt) {
        latest.set(key, { name: p.name, createdAt });
      }
    }
    const initials = new Map<string, string>();
    for (const [key, v] of latest) {
      const trimmed = v.name.trim();
      if (trimmed.length > 0) initials.set(key, trimmed.slice(0, 2).toUpperCase());
    }
    return initials;
  }, [people]);

  const recentEvents = [...events]
    .sort((a, b) =>
      a.tickNumber < b.tickNumber ? 1 : a.tickNumber > b.tickNumber ? -1 : 0
    )
    .slice(0, 10);

  const metrics: { label: string; value: string; sub?: string }[] = [
    {
      label: 'Tick',
      value: config ? Number(config.tickCount).toLocaleString() : '—',
      sub: config ? `last ${formatTime(config.lastTickAt.microsSinceUnixEpoch)}` : undefined,
    },
    {
      label: 'Creatures',
      value: config ? `${creatures.length} / ${Number(config.populationCap)}` : `${creatures.length}`,
    },
    {
      label: 'Food',
      value: config ? `${foodRows.length} / ${Number(config.foodCap)}` : `${foodRows.length}`,
    },
  ];

  return (
    <section className="panel">
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '1rem',
          flexWrap: 'wrap',
          marginBottom: '0.75rem',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span className="eyebrow">World</span>
          <button
            type="button"
            onClick={toggleMuted}
            aria-label={muted ? 'Unmute sound effects' : 'Mute sound effects'}
            aria-pressed={muted}
            title={muted ? 'Sound off' : 'Sound on'}
            style={{
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              padding: 0,
              fontSize: '0.9rem',
              lineHeight: 1,
              color: 'var(--muted)',
            }}
          >
            {muted ? '🔇' : '🔊'}
          </button>
        </span>
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
          {metrics.map(m => (
            <div key={m.label} style={{ lineHeight: 1.2 }}>
              <span className="eyebrow" style={{ fontSize: '0.62rem' }}>
                {m.label}
              </span>
              <div className="mono" style={{ fontSize: '1rem', fontWeight: 600 }}>
                {m.value}
              </div>
              {m.sub && (
                <div className="mono" style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>
                  {m.sub}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {gridSize > 0 && (
        <WorldCanvas
          gridSize={gridSize}
          creatures={creatures}
          food={foodRows}
          terrainCells={terrainCells}
          tickIntervalMs={tickIntervalMs}
          ownerInitials={ownerInitials}
        />
      )}

      <div style={{ marginTop: '1rem' }}>
        <span className="eyebrow">Recent events</span>
        <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
          {recentEvents.length === 0 && (
            <li style={{ color: 'var(--muted)' }}>Nothing has happened yet.</li>
          )}
          {recentEvents.map(e => (
            <li
              key={Number(e.id)}
              style={{
                display: 'flex',
                gap: '0.75rem',
                padding: '0.25rem 0',
                borderBottom: '1px solid var(--rule)',
              }}
            >
              <span className="mono" style={{ color: 'var(--muted)', flexShrink: 0 }}>
                {formatTime(e.at.microsSinceUnixEpoch)}
              </span>
              <span>{e.message}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
