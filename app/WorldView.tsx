'use client';

import { useMemo } from 'react';
import { useTable } from 'spacetimedb/react';
import { tables } from '../src/module_bindings';
import { WorldCanvas } from './WorldCanvas';

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
  const [foodRows] = useTable(tables.food);
  const [events] = useTable(tables.event_log);
  const [terrainRows] = useTable(tables.terrain);
  // Small guestbook table -- a second subscription alongside PersonList's own
  // is negligible here, unlike creature/food (see ARCHITECTURE.md).
  const [people] = useTable(tables.person);

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

  return (
    <div style={{ marginTop: '2rem', borderTop: '1px solid #ccc', paddingTop: '1rem' }}>
      <h2>World</h2>
      <p>
        Tick <strong>{config ? Number(config.tickCount) : '...'}</strong>
        {config && <> — last at {formatTime(config.lastTickAt.microsSinceUnixEpoch)}</>}
        {' — '}
        {creatures.length}/{config ? Number(config.populationCap) : '?'} creatures,{' '}
        {foodRows.length}/{config ? Number(config.foodCap) : '?'} food
      </p>

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

      <h3>Recent events</h3>
      <ul>
        {recentEvents.length === 0 && <li>(none yet)</li>}
        {recentEvents.map(e => (
          <li key={Number(e.id)}>
            {e.message} — {formatTime(e.at.microsSinceUnixEpoch)}
          </li>
        ))}
      </ul>
    </div>
  );
}
