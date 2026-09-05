import { schema, table, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// See CLAUDE.md "This project's decisions".
const TICK_INTERVAL_MICROS = 2_000_000n; // 2 seconds
const EVENT_LOG_MAX_ROWS = 50;

const GRID_SIZE = 40;
const DEFAULT_POPULATION_CAP = 60;
const DEFAULT_FOOD_CAP = 80;
const FOOD_SPAWN_PER_TICK = 2;
const INITIAL_CREATURE_COUNT = 8;
const INITIAL_FOOD_COUNT = 20;

const ENERGY_BURN_PER_TICK = 2;
const ENERGY_FROM_FOOD = 30;
const MAX_ENERGY = 100;
const STARVING_ENERGY_THRESHOLD = 20;
const SIZE_GROWTH_PER_MEAL = 0.05;
const SIZE_SHRINK_PER_TICK = 0.02;
const MIN_SIZE = 0.3;
const MAX_SIZE = 3;
const REPRODUCE_ENERGY_THRESHOLD = 80;
const REPRODUCE_ENERGY_COST = 40;
const CHILD_STARTING_ENERGY = 40;
const MUTATION_RANGE = 0.15; // child size = parent size * (1 +/- this), max swing

const U64_MASK = (1n << 64n) - 1n;

// A tiny deterministic PRNG (xorshift64*) seeded from world_config.rngSeed.
// Never use ctx.random() for anything that affects gameplay here — it's
// seeded from ctx.timestamp, not from table state, so a tick's outcome can't
// be explained just by reading the rows. This can: same world_config row in,
// same result out, always.
function makeRng(seed: bigint) {
  let s = seed & U64_MASK;
  if (s === 0n) s = 0x9e3779b97f4a7c15n;
  return {
    next(): number {
      s ^= s >> 12n;
      s &= U64_MASK;
      s ^= (s << 25n) & U64_MASK;
      s ^= s >> 27n;
      s &= U64_MASK;
      const out = (s * 0x2545f4914f6cdd1dn) & U64_MASK;
      return Number(out >> 11n) / 9007199254740992; // / 2^53 -> [0, 1)
    },
    int(maxExclusive: number): number {
      return Math.floor(this.next() * maxExclusive);
    },
    seed(): bigint {
      return s;
    },
  };
}

function manhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const person = table(
  { public: true },
  {
    name: t.string(),
  }
);

// Singleton row (id always 0n). Tunables and running state for the whole
// simulation live here so reducers have one source of truth instead of
// scattered constants — this is also what makes populationCap changeable
// live via a reducer, without republishing.
const world_config = table(
  { public: true },
  {
    id: t.u64().primaryKey(),
    gridSize: t.u32(),
    populationCap: t.u32(),
    foodCap: t.u32(),
    rngSeed: t.u64(),
    tickCount: t.u64(),
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

const creature = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    x: t.u32(),
    y: t.u32(),
    energy: t.f32(),
    size: t.f32(),
  }
);

const food = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    x: t.u32(),
    y: t.u32(),
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

const spacetimedb = schema({
  person,
  world_config,
  tick_schedule,
  creature,
  food,
  event_log,
});
export default spacetimedb;

export const init = spacetimedb.init(ctx => {
  const rng = makeRng(ctx.timestamp.microsSinceUnixEpoch ^ 0x9e3779b97f4a7c15n);

  for (let i = 0; i < INITIAL_CREATURE_COUNT; i++) {
    ctx.db.creature.insert({
      id: 0n,
      x: rng.int(GRID_SIZE),
      y: rng.int(GRID_SIZE),
      energy: 50,
      size: 1,
    });
  }
  for (let i = 0; i < INITIAL_FOOD_COUNT; i++) {
    ctx.db.food.insert({ id: 0n, x: rng.int(GRID_SIZE), y: rng.int(GRID_SIZE) });
  }

  // Inserted after the seeding draws above, so the stored seed reflects
  // state post-seeding rather than the raw timestamp-derived starting seed.
  ctx.db.world_config.insert({
    id: 0n,
    gridSize: GRID_SIZE,
    populationCap: DEFAULT_POPULATION_CAP,
    foodCap: DEFAULT_FOOD_CAP,
    rngSeed: rng.seed(),
    tickCount: 0n,
    lastTickAt: ctx.timestamp,
  });
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

// Tunable live, without republishing: `spacetime call prompt-wars
// set_population_cap 100 --server local`. Note the CLI uses the reducer's
// snake_case wire name, not this camelCase export name.
export const setPopulationCap = spacetimedb.reducer(
  { cap: t.u32() },
  (ctx, { cap }) => {
    const state = ctx.db.world_config.id.find(0n);
    if (!state) return;
    ctx.db.world_config.id.update({ ...state, populationCap: cap });
  }
);

export const tick = spacetimedb.reducer(
  { onSchedule: tick_schedule },
  { timer: tick_schedule.rowType },
  (ctx, { timer: _timer }) => {
    const state = ctx.db.world_config.id.find(0n);
    if (!state) return;

    const rng = makeRng(state.rngSeed);
    const tickNumber = state.tickCount + 1n;

    const creatures = [...ctx.db.creature.iter()];
    const foodByCell = new Map<string, { id: bigint; x: number; y: number }>();
    for (const f of ctx.db.food.iter()) foodByCell.set(`${f.x},${f.y}`, f);

    let population = creatures.length;
    const logs: string[] = [];

    for (const current of creatures) {
      // 1. Find the nearest food. Bounded by populationCap * foodCap per
      // tick (both hard-capped), not a spatial index — fine at 40x40 scale,
      // would need one before raising the caps much further.
      let target: { x: number; y: number } | undefined;
      let bestDist = Infinity;
      for (const f of foodByCell.values()) {
        const d = manhattan(current.x, current.y, f.x, f.y);
        if (d < bestDist) {
          bestDist = d;
          target = f;
        }
      }

      // 2. Move one cell toward it (greedy, no pathfinding). Random step if
      // there's nothing to seek, so creatures don't just freeze.
      let x = current.x;
      let y = current.y;
      if (target) {
        const dx = target.x - x;
        const dy = target.y - y;
        if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) x += Math.sign(dx);
        else if (dy !== 0) y += Math.sign(dy);
      } else {
        const dir = rng.int(4);
        if (dir === 0) x += 1;
        else if (dir === 1) x -= 1;
        else if (dir === 2) y += 1;
        else y -= 1;
      }
      x = clamp(x, 0, state.gridSize - 1);
      y = clamp(y, 0, state.gridSize - 1);

      // 3. Eat if standing on food; otherwise burn energy, and shrink if
      // starving.
      let energy = current.energy - ENERGY_BURN_PER_TICK;
      let size = current.size;
      const cellKey = `${x},${y}`;
      const eaten = foodByCell.get(cellKey);
      if (eaten) {
        energy = Math.min(MAX_ENERGY, energy + ENERGY_FROM_FOOD);
        size = Math.min(MAX_SIZE, size + SIZE_GROWTH_PER_MEAL);
        ctx.db.food.id.delete(eaten.id);
        foodByCell.delete(cellKey);
      } else if (energy < STARVING_ENERGY_THRESHOLD) {
        size = Math.max(MIN_SIZE, size - SIZE_SHRINK_PER_TICK);
      }

      // 4. Die at zero energy.
      if (energy <= 0) {
        ctx.db.creature.id.delete(current.id);
        population--;
        logs.push(`Creature #${current.id} died of starvation`);
        continue;
      }

      // 5. Reproduce above the energy threshold, mutating size, gated by
      // the hard population cap — this is what keeps growth bounded
      // forever instead of dying under its own weight overnight.
      if (energy >= REPRODUCE_ENERGY_THRESHOLD && population < state.populationCap) {
        energy -= REPRODUCE_ENERGY_COST;
        const mutation = 1 + (rng.next() * 2 - 1) * MUTATION_RANGE;
        const childSize = clamp(size * mutation, MIN_SIZE, MAX_SIZE);
        const child = ctx.db.creature.insert({
          id: 0n,
          x,
          y,
          energy: CHILD_STARTING_ENERGY,
          size: childSize,
        });
        population++;
        logs.push(
          `Creature #${current.id} reproduced -> #${child.id} (size ${childSize.toFixed(2)})`
        );
      }

      ctx.db.creature.id.update({ ...current, x, y, energy, size });
    }

    // Keep food topped up to the cap, a few cells per tick.
    let foodCount = foodByCell.size;
    for (let i = 0; i < FOOD_SPAWN_PER_TICK && foodCount < state.foodCap; i++) {
      ctx.db.food.insert({
        id: 0n,
        x: rng.int(state.gridSize),
        y: rng.int(state.gridSize),
      });
      foodCount++;
    }

    if (logs.length > 0) {
      for (const message of logs) {
        ctx.db.event_log.insert({ id: 0n, tickNumber, message, at: ctx.timestamp });
      }
      // Trim to the last EVENT_LOG_MAX_ROWS entries, ordered by tickNumber
      // (not autoInc id — ids aren't guaranteed sequential).
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

    ctx.db.world_config.id.update({
      ...state,
      rngSeed: rng.seed(),
      tickCount: tickNumber,
      lastTickAt: ctx.timestamp,
    });
  }
);
