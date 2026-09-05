import { schema, table, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// 2 seconds, in microseconds. See CLAUDE.md "This project's decisions".
const TICK_INTERVAL_MICROS = 2_000_000n;
// Keeps event_log O(1) forever instead of growing unbounded while the tick
// keeps firing with nobody connected.
const EVENT_LOG_MAX_ROWS = 50;

const person = table(
  { public: true },
  {
    name: t.string(),
  }
);

// Singleton row (id always 0n) holding the world's tick counter.
const world_tick = table(
  { public: true },
  {
    id: t.u64().primaryKey(),
    count: t.u64(),
    lastTickAt: t.timestamp(),
  }
);

// The schedule table itself is never read by clients — private by default.
const tick_schedule = table(
  {},
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const event_log = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    tickNumber: t.u64(),
    message: t.string(),
    at: t.timestamp(),
  }
);

const spacetimedb = schema({ person, world_tick, tick_schedule, event_log });
export default spacetimedb;

export const init = spacetimedb.init(ctx => {
  ctx.db.world_tick.insert({ id: 0n, count: 0n, lastTickAt: ctx.timestamp });
  ctx.db.tick_schedule.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(TICK_INTERVAL_MICROS),
  });
});

export const onConnect = spacetimedb.clientConnected(_ctx => {
  // Called every time a new client connects
});

export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {
  // Called every time a client disconnects
});

export const add = spacetimedb.reducer(
  { name: t.string() },
  (ctx, { name }) => {
    ctx.db.person.insert({ name });
  }
);

export const sayHello = spacetimedb.reducer(ctx => {
  for (const person of ctx.db.person.iter()) {
    console.info(`Hello, ${person.name}!`);
  }
  console.info('Hello, World!');
});

export const tick = spacetimedb.reducer(
  { onSchedule: tick_schedule },
  { timer: tick_schedule.rowType },
  (ctx, { timer: _timer }) => {
    const state = ctx.db.world_tick.id.find(0n);
    if (!state) return;

    const count = state.count + 1n;
    ctx.db.world_tick.id.update({ ...state, count, lastTickAt: ctx.timestamp });
    console.info(`tick #${count}`);
    ctx.db.event_log.insert({
      id: 0n,
      tickNumber: count,
      message: `Tick #${count}`,
      at: ctx.timestamp,
    });

    // Trim event_log to the last EVENT_LOG_MAX_ROWS ticks. Ordered by
    // tickNumber, not by autoInc id — ids aren't guaranteed sequential.
    const rows = [...ctx.db.event_log.iter()];
    if (rows.length > EVENT_LOG_MAX_ROWS) {
      rows.sort((a, b) =>
        a.tickNumber < b.tickNumber ? -1 : a.tickNumber > b.tickNumber ? 1 : 0
      );
      for (const stale of rows.slice(0, rows.length - EVENT_LOG_MAX_ROWS)) {
        ctx.db.event_log.id.delete(stale.id);
      }
    }
  }
);
