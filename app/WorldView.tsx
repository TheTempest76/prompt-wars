'use client';

import { useTable } from 'spacetimedb/react';
import { tables } from '../src/module_bindings';

function formatTime(micros: bigint): string {
  return new Date(Number(micros / 1000n)).toLocaleTimeString();
}

export function WorldView() {
  // All four are live subscriptions — this whole view repaints itself
  // whenever the scheduled `tick` reducer commits, no polling.
  const [configs] = useTable(tables.world_config);
  const [creatures] = useTable(tables.creature);
  const [foodRows] = useTable(tables.food);
  const [events] = useTable(tables.event_log);

  const config = configs[0];
  const gridSize = config ? Number(config.gridSize) : 0;

  // Creatures drawn over food if they share a cell.
  type Cell = { char: string; color?: string };
  const occupied = new Map<string, Cell>();
  for (const f of foodRows) occupied.set(`${f.x},${f.y}`, { char: '.' });
  for (const c of creatures) {
    occupied.set(`${c.x},${c.y}`, { char: c.glyph || 'C', color: c.color });
  }

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
        <pre style={{ lineHeight: 1, fontSize: '0.9rem' }}>
          {Array.from({ length: gridSize }, (_, y) => (
            <div key={y}>
              {Array.from({ length: gridSize }, (_, x) => {
                const cell = occupied.get(`${x},${y}`);
                return (
                  <span key={x} style={cell?.color ? { color: cell.color } : undefined}>
                    {cell?.char ?? ' '}
                  </span>
                );
              })}
            </div>
          ))}
        </pre>
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
