'use client';

import { useEffect, useMemo, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../src/module_bindings';
import { WorldCanvas } from './WorldCanvas';
import { isSfxMuted, playFoodPickup, setSfxMuted, unlockSfx } from './sfx';

// Mirrors PLAYER_FOOD_PER_WINDOW / PLAYER_FOOD_WINDOW_MICROS in
// spacetimedb/src/index.ts -- kept in sync by hand, they change rarely.
const PLAYER_FOOD_MAX = 10;
const PLAYER_FOOD_WINDOW_MS = 150 * 1000; // 2.5 minutes

function formatTime(micros: bigint): string {
  return new Date(Number(micros / 1000n)).toLocaleTimeString();
}

function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
  const [foodRows] = useTable(tables.food, {
    onDelete: row => playFoodPickup(row.kind),
  });
  const [events] = useTable(tables.event_log);
  const [terrainRows] = useTable(tables.terrain);
  // Small guestbook table -- a second subscription alongside PersonList's own
  // is negligible here, unlike creature/food (see ARCHITECTURE.md).
  const [people] = useTable(tables.person);
  const [grants] = useTable(tables.food_grant);

  const { identity } = useSpacetimeDB();
  const placeFood = useReducer(reducers.placeFood);
  const [placeMode, setPlaceMode] = useState(false);
  const [dropMsg, setDropMsg] = useState<string | null>(null);

  // Drives the live "resets in m:ss" countdown. Starts at 0 (server render) and
  // is set on mount to avoid a hydration mismatch on the timestamp.
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const myGrant = useMemo(
    () =>
      identity
        ? grants.find(g => g.owner.toHexString() === identity.toHexString())
        : undefined,
    [grants, identity]
  );
  let foodLeft = PLAYER_FOOD_MAX;
  let resetInMs = 0;
  if (myGrant && now > 0) {
    const startMs = Number(myGrant.windowStart.microsSinceUnixEpoch / 1000n);
    const elapsed = now - startMs;
    if (elapsed < PLAYER_FOOD_WINDOW_MS) {
      foodLeft = Math.max(0, PLAYER_FOOD_MAX - myGrant.used);
      resetInMs = PLAYER_FOOD_WINDOW_MS - elapsed;
    }
  }

  // Leave place mode the moment the allowance runs dry.
  useEffect(() => {
    if (foodLeft === 0) setPlaceMode(false);
  }, [foodLeft]);

  const dropFood = async (x: number, y: number) => {
    try {
      await placeFood({ x, y });
      setDropMsg(null);
    } catch (err) {
      setDropMsg(err instanceof Error ? err.message : String(err));
    }
  };

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
          <button
            type="button"
            className={placeMode ? 'btn btn-primary' : 'btn'}
            onClick={() => setPlaceMode(p => !p)}
            disabled={foodLeft === 0 && !placeMode}
            style={{ padding: '0.25rem 0.6rem', fontSize: '0.78rem' }}
            title="Drop food onto the map — 10 per 10 minutes"
          >
            {placeMode
              ? `Tap the map · ${foodLeft} left`
              : foodLeft === 0
                ? `Food refills in ${formatCountdown(resetInMs)}`
                : `Place food · ${foodLeft}`}
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
          placeMode={placeMode}
          onPlaceFood={dropFood}
        />
      )}
      {(placeMode || dropMsg) && (
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.82rem', color: dropMsg ? 'var(--bad)' : 'var(--muted)' }}>
          {dropMsg ?? `Tap anywhere on the map to drop a morsel — ${foodLeft} left, refills ${formatCountdown(resetInMs || PLAYER_FOOD_WINDOW_MS)} after your first drop.`}
        </p>
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
