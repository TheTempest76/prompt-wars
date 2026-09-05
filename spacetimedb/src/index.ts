import { schema, table, t, SenderError } from 'spacetimedb/server';
import { ScheduleAt, TimeDuration } from 'spacetimedb';

// See CLAUDE.md "This project's decisions".
const TICK_INTERVAL_MICROS = 2_000_000n; // 2 seconds
const EVENT_LOG_MAX_ROWS = 50;

// xAI's Grok API, OpenAI-compatible chat completions shape.
// Verify GROK_MODEL against https://docs.x.ai/docs/models before relying on
// it — xAI renames/retires model ids faster than most providers.
const GROK_API_URL = 'https://api.x.ai/v1/chat/completions';
const GROK_MODEL = 'grok-4';
const LLM_TIMEOUT_MILLIS = 4000;
const MAX_PROMPT_LENGTH = 200;

const GRID_SIZE = 20;
const DEFAULT_POPULATION_CAP = 20;
const DEFAULT_FOOD_CAP = 25;
const FOOD_SPAWN_PER_TICK = 1;
const INITIAL_CREATURE_COUNT = 5;
const INITIAL_FOOD_COUNT = 8;

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

const FLEE_RADIUS = 4; // cells — how far a fleesLarger creature scans for a threat
const FLEE_SIZE_MARGIN = 1.2; // a creature counts as "larger" above this multiple
const AGGRESSION_ENERGY_SCALE = 0.05; // per aggression point: burn/gain more, both ways

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

// The fixed shape Grok compiles a one-line prompt into. Small and flat on
// purpose — every field must be independently validated and clamped before
// it touches a table, so keeping the set small keeps that review honest.
type CreatureParams = {
  seeksFood: boolean;
  fleesLarger: boolean;
  aggression: number; // integer 0-10
  glyph: string; // exactly one character/emoji
  color: string; // '#rrggbb'
};

const DEFAULT_CREATURE_PARAMS: CreatureParams = {
  seeksFood: true,
  fleesLarger: false,
  aggression: 5,
  glyph: 'C',
  color: '#8888ff',
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Never trust what an LLM hands back. Every field falls back to
// DEFAULT_CREATURE_PARAMS independently if it's missing, the wrong type, or
// out of range — a partially-garbage response still yields a valid creature.
function clampCreatureParams(raw: unknown): CreatureParams {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  const seeksFood = typeof r.seeksFood === 'boolean' ? r.seeksFood : DEFAULT_CREATURE_PARAMS.seeksFood;
  const fleesLarger = typeof r.fleesLarger === 'boolean' ? r.fleesLarger : DEFAULT_CREATURE_PARAMS.fleesLarger;
  const aggression =
    typeof r.aggression === 'number' && Number.isFinite(r.aggression)
      ? clamp(Math.round(r.aggression), 0, 10)
      : DEFAULT_CREATURE_PARAMS.aggression;

  const glyphSource = typeof r.glyph === 'string' ? [...r.glyph][0] : undefined;
  const glyph = glyphSource && glyphSource.length > 0 ? glyphSource : DEFAULT_CREATURE_PARAMS.glyph;

  const colorSource = typeof r.color === 'string' ? r.color : '';
  const color = HEX_COLOR_RE.test(colorSource) ? colorSource : DEFAULT_CREATURE_PARAMS.color;

  return { seeksFood, fleesLarger, aggression, glyph, color };
}

// Grok is asked for pure JSON but sometimes wraps it in a markdown fence
// anyway — strip that defensively before JSON.parse rather than failing.
function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

function describeCreatureParams(params: CreatureParams): string {
  const parts = [params.seeksFood ? 'seeks food' : 'wanders randomly'];
  if (params.fleesLarger) parts.push('flees larger creatures');
  parts.push(`aggression ${params.aggression}/10`);
  return parts.join(', ') + '.';
}

const CREATURE_COMPILE_SYSTEM_PROMPT = `You compile a one-sentence creature description into fixed-shape JSON game parameters for a small ecosystem simulation.
Output ONLY a single JSON object, no prose, no markdown fences, matching exactly this shape:
{
  "seeksFood": boolean,       // does it actively hunt for food, or just wander?
  "fleesLarger": boolean,     // does it flee from creatures bigger than itself?
  "aggression": integer 0-10, // 0 = passive, 10 = very aggressive
  "glyph": "X",               // one character or emoji representing it visually
  "color": "#rrggbb"          // hex color string
}`;

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
    glyph: t.string(),
    color: t.string(),
    seeksFood: t.bool(),
    fleesLarger: t.bool(),
    aggression: t.u8(),
    prompt: t.string(), // the original one-line description, for explainability
  }
);

// Private — the API key never touches a client. Write-once-per-owner: the
// first identity to call setLlmKey becomes the owner and can rotate it
// later; nobody else can overwrite it. See CLAUDE.md's LLM-secret decision.
const llm_secret = table(
  {},
  {
    id: t.u64().primaryKey(),
    owner: t.identity(),
    apiKey: t.string(),
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
  llm_secret,
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
      ...DEFAULT_CREATURE_PARAMS,
      prompt: '(seed creature)',
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
      // 1. fleesLarger creatures scan for a nearby bigger threat first —
      // fleeing overrides feeding this tick. Otherwise seekers find the
      // nearest food. Both bounded by populationCap/foodCap (hard-capped),
      // not a spatial index — fine at this grid size, would need one before
      // raising the caps much further.
      let fleeFrom: { x: number; y: number } | undefined;
      if (current.fleesLarger) {
        let bestThreatDist = Infinity;
        for (const other of creatures) {
          if (other.id === current.id) continue;
          if (other.size <= current.size * FLEE_SIZE_MARGIN) continue;
          const d = manhattan(current.x, current.y, other.x, other.y);
          if (d <= FLEE_RADIUS && d < bestThreatDist) {
            bestThreatDist = d;
            fleeFrom = other;
          }
        }
      }

      let target: { x: number; y: number } | undefined;
      if (!fleeFrom && current.seeksFood) {
        let bestDist = Infinity;
        for (const f of foodByCell.values()) {
          const d = manhattan(current.x, current.y, f.x, f.y);
          if (d < bestDist) {
            bestDist = d;
            target = f;
          }
        }
      }

      // 2. Move one cell toward the food target, away from a threat, or a
      // random step if neither applies (greedy either way, no pathfinding).
      let x = current.x;
      let y = current.y;
      if (fleeFrom) {
        const dx = x - fleeFrom.x;
        const dy = y - fleeFrom.y;
        if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) x += Math.sign(dx);
        else if (dy !== 0) y += Math.sign(dy);
        else x += rng.int(2) === 0 ? 1 : -1; // directly on top of the threat
      } else if (target) {
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
      // starving. Aggression trades burn rate for gain rate either way —
      // no free lunch for a "voracious" creature.
      const aggressionScale = 1 + current.aggression * AGGRESSION_ENERGY_SCALE;
      let energy = current.energy - ENERGY_BURN_PER_TICK * aggressionScale;
      let size = current.size;
      const cellKey = `${x},${y}`;
      const eaten = foodByCell.get(cellKey);
      if (eaten) {
        energy = Math.min(MAX_ENERGY, energy + ENERGY_FROM_FOOD * aggressionScale);
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
        // Behavior params (glyph/color/seeksFood/fleesLarger/aggression)
        // are inherited unchanged — only size mutates on reproduction.
        // Deliberate scope choice: evolving behavior genetics further is
        // outside what this checkpoint asked for.
        const child = ctx.db.creature.insert({
          id: 0n,
          x,
          y,
          energy: CHILD_STARTING_ENERGY,
          size: childSize,
          glyph: current.glyph,
          color: current.color,
          seeksFood: current.seeksFood,
          fleesLarger: current.fleesLarger,
          aggression: current.aggression,
          prompt: current.prompt,
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

// Set (or, called again by the same owner, rotate) the Grok API key. The
// first identity ever to call this becomes the permanent owner — call it
// yourself right after your first publish, before sharing the URL, so a
// stranger can't claim it first. Rotate an existing key by deleting the row
// via `spacetime sql` and calling this again, or by calling it again as the
// same owner identity.
export const setLlmKey = spacetimedb.reducer(
  { apiKey: t.string() },
  (ctx, { apiKey }) => {
    const existing = ctx.db.llm_secret.id.find(0n);
    if (existing) {
      if (!existing.owner.equals(ctx.sender)) {
        throw new SenderError('LLM key already set by a different identity.');
      }
      ctx.db.llm_secret.id.update({ ...existing, apiKey });
    } else {
      ctx.db.llm_secret.insert({ id: 0n, owner: ctx.sender, apiKey });
    }
  }
);

const SpawnResult = t.object('SpawnResult', {
  creatureId: t.option(t.u64()),
  summary: t.string(),
});

// The only place in this module allowed to make an outbound HTTP call — see
// CLAUDE.md "Procedures and outbound HTTP". Runs once at spawn, never per
// tick. If Grok isn't configured, times out, or returns garbage, params
// silently fall back to DEFAULT_CREATURE_PARAMS and the creature still
// spawns — the game must never be blocked on an external API.
export const spawnFromPrompt = spacetimedb.procedure(
  { prompt: t.string() },
  SpawnResult,
  (ctx, { prompt }) => {
    const trimmedPrompt = prompt.trim().slice(0, MAX_PROMPT_LENGTH);
    let params = DEFAULT_CREATURE_PARAMS;

    const secret = ctx.withTx(tx => tx.db.llm_secret.id.find(0n));
    if (secret && trimmedPrompt.length > 0) {
      try {
        const res = ctx.http.fetch(GROK_API_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secret.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: GROK_MODEL,
            max_tokens: 300,
            messages: [
              { role: 'system', content: CREATURE_COMPILE_SYSTEM_PROMPT },
              { role: 'user', content: trimmedPrompt },
            ],
          }),
          timeout: TimeDuration.fromMillis(LLM_TIMEOUT_MILLIS),
        });
        if (res.status === 200) {
          const body = JSON.parse(res.text());
          const content = body?.choices?.[0]?.message?.content;
          if (typeof content === 'string') {
            params = clampCreatureParams(JSON.parse(stripJsonFences(content)));
          }
        }
      } catch {
        // Network error, timeout, or malformed JSON. Fall through to
        // DEFAULT_CREATURE_PARAMS — never block the spawn on this.
      }
    }

    const child = ctx.withTx(tx => {
      const state = tx.db.world_config.id.find(0n);
      if (!state) return undefined;
      if ([...tx.db.creature.iter()].length >= state.populationCap) return undefined;

      const rng = makeRng(state.rngSeed);
      const row = tx.db.creature.insert({
        id: 0n,
        x: rng.int(state.gridSize),
        y: rng.int(state.gridSize),
        energy: CHILD_STARTING_ENERGY,
        size: 1,
        glyph: params.glyph,
        color: params.color,
        seeksFood: params.seeksFood,
        fleesLarger: params.fleesLarger,
        aggression: params.aggression,
        prompt: trimmedPrompt,
      });
      tx.db.world_config.id.update({ ...state, rngSeed: rng.seed() });
      return row;
    });

    if (!child) {
      return {
        creatureId: undefined,
        summary: 'The world is full right now — try again once something dies.',
      };
    }
    return { creatureId: child.id, summary: describeCreatureParams(params) };
  }
);
