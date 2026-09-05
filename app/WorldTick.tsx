'use client';

import { useTable } from 'spacetimedb/react';
import { tables } from '../src/module_bindings';

function formatTime(micros: bigint): string {
  return new Date(Number(micros / 1000n)).toLocaleTimeString();
}

export function WorldTick() {
  // Live subscriptions — this survives page reloads and re-renders the
  // moment the scheduled `tick` reducer commits, no polling.
  const [ticks] = useTable(tables.world_tick);
  const [events] = useTable(tables.event_log);

  const tick = ticks[0];
  const recentEvents = [...events]
    .sort((a, b) =>
      a.tickNumber < b.tickNumber ? 1 : a.tickNumber > b.tickNumber ? -1 : 0
    )
    .slice(0, 10);

  return (
    <div style={{ marginTop: '2rem', borderTop: '1px solid #ccc', paddingTop: '1rem' }}>
      <h2>World Tick</h2>
      <p>
        Tick count: <strong>{tick ? Number(tick.count) : '...'}</strong>
        {tick && <> — last tick at {formatTime(tick.lastTickAt.microsSinceUnixEpoch)}</>}
      </p>
      <ul>
        {recentEvents.map(e => (
          <li key={Number(e.id)}>
            {e.message} — {formatTime(e.at.microsSinceUnixEpoch)}
          </li>
        ))}
      </ul>
    </div>
  );
}
