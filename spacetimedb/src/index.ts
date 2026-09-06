import { schema, table, t, SenderError } from 'spacetimedb/server';
import { ScheduleAt, TimeDuration, Timestamp, Identity } from 'spacetimedb';

// See CLAUDE.md "This project's decisions".
const TICK_INTERVAL_MICROS = 2_000_000n; // 2 seconds
const EVENT_LOG_MAX_ROWS = 50;

// Groq (api.groq.com — the fast-inference API, NOT xAI's "Grok"; a "gsk_"
// key prefix means Groq). OpenAI-compatible chat completions shape.
// Verify GROK_MODEL against https://console.groq.com/docs/models before
// relying on it — model availability there changes often.
const GROK_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROK_MODEL = 'openai/gpt-oss-20b'; // reasoning model — see LLM_MAX_TOKENS below
const LLM_MAX_TOKENS = 800; // must cover reasoning tokens *and* the JSON content -- bumped from 500 after live seeding showed ~13% of calls truncating before emitting glyph/habitat and falling back to defaults
const LLM_TIMEOUT_MILLIS = 4000;
const MAX_PROMPT_LENGTH = 200;

const GRID_SIZE = 300; // seed value for fresh installs — see setGridSize for live worlds. Big on purpose: the client now starts zoomed into a fraction of it, revealing more as the camera pans, rather than fitting the whole thing on first load.
// Bumped significantly from the 20/25/1 the world shipped an 80x80 grid
// with — that combination sat at cap almost immediately and read as
// saturated/static rather than alive and growing. All three now also live
// on world_config (foodSpawnPerTick alongside the pre-existing foodCap), so
// these are just the seed values for fresh installs, not hard limits.
const DEFAULT_POPULATION_CAP = 50;
// Scaled up from 120/5 (tuned for the original 80x80 grid) when GRID_SIZE
// grew to 300 -- same food *count*, 14x the area, means ~14x farther to the
// nearest food on average, which was starving out the population before it
// could reproduce (observed directly: population crashed toward zero after
// the grid grew). Only partially rescaled with area (roughly 3x, not the
// full 14x food density would take to match the original) as a deliberate
// tradeoff against canvas draw cost on mobile -- every food row is two
// draws per frame (bloom + fill), and that hasn't been measured on a real
// phone. Retune with setFoodConfig if this turns out wrong in either
// direction.
const DEFAULT_FOOD_CAP = 350;
const DEFAULT_FOOD_SPAWN_PER_TICK = 15;
const INITIAL_CREATURE_COUNT = 5;
const INITIAL_FOOD_COUNT = 8;

const ENERGY_BURN_PER_TICK = 2;
const ENERGY_FROM_FOOD = 30;
const MAX_ENERGY = 100;
const STARVING_ENERGY_THRESHOLD = 20;
// The whole size system is scaled 4x from its original values (starting size
// was 1) purely to make creatures read bigger on-canvas -- every constant
// below and PREDATOR_SIZE moved together, so all the size *ratios*
// (flee margin, predator-vs-prey, growth headroom) are unchanged.
const STARTING_SIZE = 4;
const SIZE_GROWTH_PER_MEAL = 0.6; // 4x of 0.15
const SIZE_SHRINK_PER_TICK = 0.08; // 4x of 0.02
const MIN_SIZE = 1.2; // 4x of 0.3
const MAX_SIZE = 12; // 4x of 3
const REPRODUCE_ENERGY_THRESHOLD = 80;
const REPRODUCE_ENERGY_COST = 40;
const CHILD_STARTING_ENERGY = 40;
const MUTATION_RANGE = 0.15; // child size = parent size * (1 +/- this), max swing

// Population floor: if the world thins past minPopulation, `tick` restocks
// restockAmount creatures so it can't quietly spiral to zero when nobody is
// watching. Both live on world_config (retunable via setPopulationFloor);
// these are just the fresh-install seed values. Restocked creatures start
// well-fed so the top-up actually takes instead of immediately starving.
const DEFAULT_MIN_POPULATION = 20;
const DEFAULT_RESTOCK_AMOUNT = 10;
const RESTOCK_STARTING_ENERGY = 75;

// Player-dropped food: each visitor gets PLAYER_FOOD_PER_WINDOW placements,
// and the allowance refills PLAYER_FOOD_WINDOW_MICROS after the first drop of
// a batch (a rolling window per identity, tracked in food_grant).
const PLAYER_FOOD_PER_WINDOW = 10;
const PLAYER_FOOD_WINDOW_MICROS = 150n * 1_000_000n; // 2.5 minutes

// --- Powerups -------------------------------------------------------------
// Rare, desirable, non-essential. Five kinds, index = powerup.kind:
//   0 transmute     -- reroll the creature's traits/glyph/colour (one-time)
//   1 speed_burst   -- 2x movement for SPEED_BURST_TICKS
//   2 energy_surge  -- +ENERGY_SURGE_BONUS now, then 1.5x burn for a while
//   3 clone         -- exact free duplicate (counts toward pop cap)
//   4 hunger_zero   -- ignores food, wanders, for HUNGER_ZERO_TICKS
const POWERUP_KIND_COUNT = 5;
const POWERUP_LABELS = ['Transmute', 'Speed Burst', 'Energy Surge', 'Clone', 'Hunger Zero'];
const SPEED_BURST_TICKS = 20n;
const ENERGY_SURGE_TICKS = 15n;
const ENERGY_SURGE_BONUS = 50;
const ENERGY_SURGE_BURN_MULT = 1.5;
const HUNGER_ZERO_TICKS = 25n;
const TRANSMUTE_RESET_ENERGY = 50;
const POWERUP_CLAIM_RADIUS = 60; // cells: your nearest creature must be this close to claim
// Spread into every fresh creature.insert -- .default() columns still have to
// be supplied explicitly. A newborn/seed/predator has no active powerup.
const NO_EFFECTS = { speedUntilTick: 0n, surgeUntilTick: 0n, hungerZeroUntilTick: 0n } as const;
const DEFAULT_POWERUP_CAP = 2;
const DEFAULT_POWERUP_SPAWN_EVERY_TICKS = 30; // ~60s at a 2s tick
const DEFAULT_POWERUP_DESPAWN_TICKS = 60; // ~120s at a 2s tick

const FLEE_RADIUS = 15; // cells — how far a fleesLarger creature scans for a threat. Scaled with GRID_SIZE (was 4 at grid 80, same ~5% proportion) -- a fixed radius on a much bigger grid would almost never see anything
const FLEE_SIZE_MARGIN = 1.2; // a creature counts as "larger" above this multiple

// Cross-species predation between ordinary creatures (separate from the
// world predator): a much bigger, not-timid creature that ends its move
// touching a smaller one eats it. The size bar sits ABOVE the flee bar, so a
// creature that flees at 1.2x actually gains ground before it's edible.
const CANNIBAL_SIZE_RATIO = 1.5;
const CANNIBAL_MIN_AGGRESSION = 3; // timid creatures don't hunt their own kind
const ENERGY_FROM_PREY = 25;
const AGGRESSION_ENERGY_SCALE = 0.05; // per aggression point: burn/gain more, both ways

// Predators: world-spawned, never player-authored -- no owner, no prompt
// beyond a fixed marker, no lineage. A flag on the existing creature table
// (not a new one) reuses the entire movement/energy/render pipeline.
const PREDATOR_HUNT_RADIUS = 45; // cells -- bounded search, same complexity class as flee/food search. Scaled with GRID_SIZE (was 12 at grid 80, same ~15% proportion) -- at the old fixed radius a predator would almost never find prey on a much bigger, sparser grid
const PREDATOR_SIZE = 7.2; // 4x of 1.8 -- still bigger than the ~4-5 typical creature, reads as a threat and works for "smaller than itself" comparisons
const PREDATOR_STARTING_ENERGY = 60;
const PREDATOR_ENERGY_BURN_PER_TICK = 3; // hunting costs more than grazing
const PREDATOR_ENERGY_FROM_KILL = 50;
const PREDATOR_MAX_KILLS = 5; // hard despawn safety net, independent of energy tuning
const PREDATOR_COLOR = '#ff3f3f';
const PREDATOR_GLYPH = '▲'; // ▲ -- unused for client shape (client draws a diamond), kept for parity/debugging
// Spawn condition: ecological pressure, not a timer. Overcrowded = enough
// population relative to available food; MIN_POPULATION guards against
// culling an already-struggling world further; MAX_ACTIVE bounds how many
// predators can exist at once regardless of how overcrowded things get.
// Calibrated empirically, not guessed: with populationCap 60 / foodCap 120,
// a healthy fed-and-growing population sat at population/foodCount ~0.5-0.8
// (60 pop, 79-100ish food) -- a ratio of 1.5 essentially never fires under
// normal operation, since food climbing toward its cap drives the ratio
// *down* as the world thrives. 0.7 actually engages during real fluctuation
// while population is still climbing toward cap, without needing the world
// to be in genuine crisis first.
const PREDATOR_SPAWN_POP_FOOD_RATIO = 0.7;
const PREDATOR_MIN_POPULATION_TO_SPAWN = 15;
const PREDATOR_MAX_ACTIVE = 2;

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
}

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

// The world is a torus -- walk off one edge, come back on the opposite one,
// so creatures never pile up against a wall (a "circular queue" grid). These
// three helpers are what make distance and heading wrap.
function wrapCoord(v: number, size: number): number {
  return ((v % size) + size) % size;
}
// Signed shortest step from `from` to `to` on a wrapped axis of length `size`.
function torusDelta(from: number, to: number, size: number): number {
  let d = to - from;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  return d;
}
function torusManhattan(ax: number, ay: number, bx: number, by: number, size: number): number {
  return Math.abs(torusDelta(ax, bx, size)) + Math.abs(torusDelta(ay, by, size));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Biome indices — also the literal characters stored in terrain.cells (one
// char per cell, e.g. cells[y*gridSize+x] === '2' means thermal vent).
const BIOME_BLOOM = 0; // Nutrient bloom: food spawn high, energy burn normal
const BIOME_COLD = 1; // Cold shelf: food spawn low, energy burn low
const BIOME_VENT = 2; // Thermal vent: food spawn high, energy burn high
const BIOME_BARREN = 3; // Barren: food spawn none, energy burn normal
const BIOME_COUNT = 4;
// Two octaves of value noise per biome. Grid point counts are fixed, not
// scaled by gridSize, so patch size stays a roughly constant *fraction* of
// the grid regardless of size: with a size-cell grid interpolated from a
// (N x N) control grid, one control interval spans size/(N-1) world cells.
// N=6 -> ~20% of the grid per patch (the dominant, "readable region" scale);
// N=10 -> ~11% (secondary texture, blended at lower weight so it adds
// natural irregularity without breaking up the large-scale pattern).
const TERRAIN_COARSE_CELLS = 6;
const TERRAIN_FINE_CELLS = 10;
const TERRAIN_COARSE_WEIGHT = 0.65;
const TERRAIN_FINE_WEIGHT = 0.35;

// Reads a biome index out of a packed terrain string; -1 (unknown) is a
// safe "no effect" value for callers, covering both "no terrain row yet"
// and an out-of-bounds index (e.g. grid grew before terrain regenerated).
function biomeAt(cells: string | undefined, gridSize: number, x: number, y: number): number {
  if (!cells) return -1;
  const idx = y * gridSize + x;
  if (idx < 0 || idx >= cells.length) return -1;
  const digit = cells.charCodeAt(idx) - 48; // '0'.charCodeAt(0)
  return digit >= 0 && digit < BIOME_COUNT ? digit : -1;
}

// One shared lookup for both food-spawn and energy-burn multipliers —
// same shape, different four numbers, and plain-number params avoid needing
// a typed WorldConfig-row parameter for a two-line function.
function multiplierForBiome(
  biome: number,
  bloom: number,
  cold: number,
  vent: number,
  barren: number
): number {
  switch (biome) {
    case BIOME_BLOOM: return bloom;
    case BIOME_COLD: return cold;
    case BIOME_VENT: return vent;
    case BIOME_BARREN: return barren;
    default: return 1; // unknown biome -> neutral, never blocks simulation
  }
}

// Food kinds. `kind` is a column on `food` (0 = the old single food type,
// unchanged, so a live world's existing rows keep behaving identically).
// Each eats to a different energy/size payoff, so *where* a creature forages
// starts to matter -- and each concentrates in the biome it belongs to
// without ever being the only thing that spawns there.
//   0 plankton -- common staple: balanced energy + growth (the old values)
//   1 spore    -- mostly growth, little energy; clusters in nutrient blooms
//   2 mineral  -- dense energy, no growth; clusters near thermal vents
const FOOD_KIND_PLANKTON = 0;
const FOOD_KIND_MINERAL = 2; // the dense-energy morsel worth fighting over (kind 1 = spore)
const FOOD_KINDS: ReadonlyArray<{ energy: number; growth: number; weight: number; biome: number }> = [
  { energy: ENERGY_FROM_FOOD, growth: SIZE_GROWTH_PER_MEAL, weight: 0.70, biome: -1 },
  { energy: 10, growth: SIZE_GROWTH_PER_MEAL * 2.6, weight: 0.20, biome: BIOME_BLOOM },
  { energy: ENERGY_FROM_FOOD * 2, growth: 0, weight: 0.10, biome: BIOME_VENT },
];

// "Ability matchup" used when two creatures reach for the same food cell in
// one tick: size is the dominant trait (a bigger organism just crowds a
// smaller one off the morsel), aggression is the tiebreak among similar
// sizes. Pure function of row data -- a contest's outcome stays replayable,
// see CLAUDE.md determinism decision.
function contestScore(c: { size: number; aggression: number }): number {
  return c.size * 10 + c.aggression;
}

// Weighted pick of a food kind for a spawn, biased toward the cell's biome:
// a kind whose preferred biome matches gets 3x its base weight. Falls back
// to plankton on any degenerate input -- never blocks a food spawn.
function pickFoodKind(rng: ReturnType<typeof makeRng>, biomeHere: number): number {
  const weights: number[] = [];
  let total = 0;
  for (const k of FOOD_KINDS) {
    const w = k.biome === biomeHere ? k.weight * 3 : k.weight;
    weights.push(w);
    total += w;
  }
  if (total <= 0) return FOOD_KIND_PLANKTON;
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return FOOD_KIND_PLANKTON;
}

// Approximate spawn location from a prompt's inferred habitat: reservoir-
// samples one matching-biome cell in a single pass (no full match list
// allocated for what can be a 90,000+ cell scan) so a "cold" creature lands
// somewhere on a cold shelf, not just anywhere on the map. biome < 0 (no
// preference) or no terrain/biome match falls back to uniform random --
// this always returns a usable position, never blocks a spawn.
function pickSpawnPosition(
  rng: ReturnType<typeof makeRng>,
  cells: string | undefined,
  size: number,
  biome: number
): { x: number; y: number } {
  if (biome >= 0 && cells && cells.length === size * size) {
    let chosenIdx = -1;
    let seen = 0;
    for (let i = 0; i < cells.length; i++) {
      if (cells.charCodeAt(i) - 48 === biome) {
        seen++;
        if (rng.int(seen) === 0) chosenIdx = i; // uniform reservoir sample among matches so far
      }
    }
    if (chosenIdx !== -1) {
      return { x: chosenIdx % size, y: Math.floor(chosenIdx / size) };
    }
  }
  return { x: rng.int(size), y: rng.int(size) };
}

// A small (w x h) grid of independent random values in [0, 1) — the
// low-resolution "control points" a value-noise field interpolates between.
function randomGrid(rng: ReturnType<typeof makeRng>, w: number, h: number): number[] {
  const g = new Array<number>(w * h);
  for (let i = 0; i < w * h; i++) g[i] = rng.next();
  return g;
}

// Bilinear sample of a small control grid at continuous world coordinate
// (wx, wy) in [0, size). This — not per-cell randomness — is what makes the
// field low-frequency: a tiny grid stretched smoothly over the whole world
// varies slowly, so regions stay large and boundaries stay soft.
function sampleGrid(grid: number[], gw: number, gh: number, size: number, wx: number, wy: number): number {
  const gx = (wx / size) * (gw - 1);
  const gy = (wy / size) * (gh - 1);
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(gw - 1, x0 + 1);
  const y1 = Math.min(gh - 1, y0 + 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const v00 = grid[y0 * gw + x0];
  const v10 = grid[y0 * gw + x1];
  const v01 = grid[y1 * gw + x0];
  const v11 = grid[y1 * gw + x1];
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}

// Generates one independently-seeded 2-octave noise field per biome, then
// picks the highest-valued biome at each cell (a smooth generalization of
// "nearest seed" — smooth fields naturally produce several separated local
// maxima each, spreading every biome across multiple regions instead of
// risking a handful of random points clustering by chance). No per-cell
// randomness anywhere in this — that's what keeps regions large and the
// boundaries between them soft curves rather than static.
// O(size^2 * BIOME_COUNT) bilinear samples — a one-time generation cost,
// never run per tick.
function generateTerrainCells(rng: ReturnType<typeof makeRng>, size: number): string {
  const fields = [];
  for (let biome = 0; biome < BIOME_COUNT; biome++) {
    fields.push({
      coarse: randomGrid(rng, TERRAIN_COARSE_CELLS, TERRAIN_COARSE_CELLS),
      fine: randomGrid(rng, TERRAIN_FINE_CELLS, TERRAIN_FINE_CELLS),
    });
  }

  const chars = new Array<string>(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bestBiome = BIOME_BLOOM;
      let bestValue = -Infinity;
      for (let biome = 0; biome < BIOME_COUNT; biome++) {
        const f = fields[biome];
        const value =
          sampleGrid(f.coarse, TERRAIN_COARSE_CELLS, TERRAIN_COARSE_CELLS, size, x, y) * TERRAIN_COARSE_WEIGHT +
          sampleGrid(f.fine, TERRAIN_FINE_CELLS, TERRAIN_FINE_CELLS, size, x, y) * TERRAIN_FINE_WEIGHT;
        if (value > bestValue) {
          bestValue = value;
          bestBiome = biome;
        }
      }
      chars[y * size + x] = String(bestBiome);
    }
  }
  return chars.join('');
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
  glyph: '🦠', // generic organism -- fits the theme better than a bare letter
  color: '#8888ff',
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HABITAT_NAME_TO_BIOME: Record<string, number> = {
  bloom: BIOME_BLOOM,
  cold: BIOME_COLD,
  vent: BIOME_VENT,
  barren: BIOME_BARREN,
};
const HABITAT_DESCRIPTIONS = ['a nutrient bloom', 'a cold shelf', 'a thermal vent', 'the barrens'];

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

// Habitat is deliberately NOT a field on CreatureParams/the creature row --
// it only ever affects where spawnFromPrompt places the new row, once, and
// keeping it separate means DEFAULT_CREATURE_PARAMS stays exactly the shape
// that gets spread into ctx.db.creature.insert() everywhere (init, tick
// reproduction, spawnFromPrompt) without an excess-property risk anywhere.
// -1 means no preference -- fall back to a uniform-random position.
function clampHabitat(raw: unknown): number {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const habitat = typeof r.habitat === 'string' ? r.habitat.toLowerCase().trim() : '';
  return habitat in HABITAT_NAME_TO_BIOME ? HABITAT_NAME_TO_BIOME[habitat] : -1;
}

// Grok is asked for pure JSON but sometimes wraps it in a markdown fence
// anyway — strip that defensively before JSON.parse rather than failing.
function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

function describeCreatureParams(params: CreatureParams, habitatBiome: number): string {
  const parts = [params.seeksFood ? 'seeks food' : 'wanders randomly'];
  if (params.fleesLarger) parts.push('flees larger creatures');
  parts.push(`aggression ${params.aggression}/10`);
  if (habitatBiome >= 0 && habitatBiome < HABITAT_DESCRIPTIONS.length) {
    parts.push(`spawned near ${HABITAT_DESCRIPTIONS[habitatBiome]}`);
  }
  return parts.join(', ') + '.';
}

// "Lineage name" for event-log lines about a player's creature: the latest
// name that creature's owning identity signed in the guestbook, else a
// #id fallback. Takes a plain snapshot array so it works from both a
// reducer and a procedure context without a typed-ctx parameter.
type PersonSnapshot = { name: string; owner?: Identity; createdAt: Timestamp };
function lineageName(people: PersonSnapshot[], owner: Identity | undefined, fallbackId: bigint): string {
  if (owner) {
    let best: { name: string; at: bigint } | undefined;
    for (const p of people) {
      if (!p.owner || !p.owner.equals(owner)) continue;
      const at = p.createdAt.microsSinceUnixEpoch;
      if (!best || at > best.at) best = { name: p.name.trim(), at };
    }
    if (best && best.name.length > 0) return best.name;
  }
  return `Creature #${fallbackId}`;
}

const CREATURE_COMPILE_SYSTEM_PROMPT = `You compile a one-sentence creature description into fixed-shape JSON game parameters for a small ecosystem simulation.
Output ONLY a single JSON object, no prose, no markdown fences, matching exactly this shape:
{
  "seeksFood": boolean,       // does it actively hunt for food, or just wander?
  "fleesLarger": boolean,     // does it flee from creatures bigger than itself?
  "aggression": integer 0-10, // 0 = passive, 10 = very aggressive
  "glyph": <a single emoji that best visually represents this specific creature -- always a real emoji, never a plain letter. Pick the closest real-world match, e.g. "🦂" for a scorpion, "🐧" for a penguin, "🐉" for a dragon>,
  "color": <pick a hex color string that visually fits it, e.g. "#d94f2b">,
  "habitat": <one of "bloom", "cold", "vent", "barren", or "any" -- which environment best fits this creature based on its description. Fire/heat/lava -> "vent". Ice/snow/arctic -> "cold". Plant/jungle/lush -> "bloom". Desert/wasteland/rock -> "barren". No clear preference -> "any">
}`;

const person = table(
  { public: true },
  {
    name: t.string(),
    // Profile-name feature: owner/createdAt let the client find "the latest
    // name this identity submitted" (filter by owner, max createdAt) without
    // changing person into an upsert-per-identity table -- the guestbook
    // stays an append-only log, this just makes it possible to derive a
    // per-identity display name from it. Both optional/defaulted so
    // pre-existing rows (from before this feature) don't need a migration.
    owner: t.option(t.identity()).default(undefined),
    createdAt: t.timestamp().default(new Timestamp(0n)),
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
    // Biome multipliers — retunable live via setBiomeMultipliers, never a
    // republish. Appended (not inserted earlier in the row) with defaults so
    // this migrates onto an already-running world via a normal hot-swap
    // publish instead of a --delete-data wipe: SpacetimeDB requires new
    // columns to be appended, not reordered into the middle of a table.
    bloomFoodMult: t.f32().default(2.0),
    bloomBurnMult: t.f32().default(1.0),
    coldFoodMult: t.f32().default(0.4),
    coldBurnMult: t.f32().default(0.6),
    ventFoodMult: t.f32().default(2.2),
    ventBurnMult: t.f32().default(1.5),
    barrenFoodMult: t.f32().default(0.0),
    barrenBurnMult: t.f32().default(1.0),
    // Appended (not grouped next to foodCap above) for the same reason —
    // new columns must be appended, never inserted mid-table. Retunable
    // live via setFoodConfig.
    foodSpawnPerTick: t.u32().default(DEFAULT_FOOD_SPAWN_PER_TICK),
    // Mirrors tick_schedule's actual interval -- setTickSpeed updates both
    // in the same call. This copy exists so the client can read the current
    // speed (for accurate position-interpolation timing) without needing
    // access to the private tick_schedule table.
    tickIntervalMicros: t.u64().default(TICK_INTERVAL_MICROS),
    // Population floor -- appended with defaults, same migrate-in-place reason
    // as the columns above. Retunable live via setPopulationFloor.
    minPopulation: t.u32().default(DEFAULT_MIN_POPULATION),
    restockAmount: t.u32().default(DEFAULT_RESTOCK_AMOUNT),
    // Powerups -- retunable via setPowerupConfig.
    powerupCap: t.u32().default(DEFAULT_POWERUP_CAP),
    powerupSpawnEveryTicks: t.u32().default(DEFAULT_POWERUP_SPAWN_EVERY_TICKS),
    powerupDespawnTicks: t.u32().default(DEFAULT_POWERUP_DESPAWN_TICKS),
  }
);

// Terrain never changes after generation (regenerated wholesale only on
// setGridSize or an explicit regenerateTerrain call) — one singleton row
// holding a packed string, one character per cell, NOT one row per tile.
// At 80x80 that's 6.4KB of text in the subscription; one row per cell would
// be 6400 rows for data that's otherwise completely static.
const terrain = table(
  { public: true },
  {
    id: t.u64().primaryKey(),
    cells: t.string(),
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
    // Defaults let this migrate onto an already-running world (e.g. Maincloud)
    // via a normal hot-swap publish instead of a --delete-data wipe —
    // pre-existing rows backfill with these values.
    glyph: t.string().default(DEFAULT_CREATURE_PARAMS.glyph),
    color: t.string().default(DEFAULT_CREATURE_PARAMS.color),
    seeksFood: t.bool().default(DEFAULT_CREATURE_PARAMS.seeksFood),
    fleesLarger: t.bool().default(DEFAULT_CREATURE_PARAMS.fleesLarger),
    aggression: t.u8().default(DEFAULT_CREATURE_PARAMS.aggression),
    prompt: t.string().default('(pre-existing)'), // for explainability
    // Appended, same reason as everywhere else in this table -- new columns
    // go at the end. A world-spawned predator: isPredator true means every
    // other player-authored field (seeksFood/fleesLarger/aggression/prompt)
    // is ignored in favor of hunt/burn/despawn logic in `tick`.
    isPredator: t.bool().default(false),
    kills: t.u32().default(0),
    // Profile-name feature: which identity spawned this creature, so the
    // client can label it with that identity's latest `person.name`
    // initials. Undefined for seed/predator creatures (never player-spawned)
    // -- a reproduced child inherits its parent's owner, so a whole lineage
    // stays tagged to whoever originally spawned it.
    owner: t.option(t.identity()).default(undefined),
    // Powerup effect timers -- 0n means "no effect". Each holds the tick
    // number the effect lapses on; `tick` reads them, applies the modifier
    // while active, and clears+logs on expiry. Appended with defaults so
    // this migrates onto a live world.
    speedUntilTick: t.u64().default(0n),
    surgeUntilTick: t.u64().default(0n),
    hungerZeroUntilTick: t.u64().default(0n),
  }
);

// Powerups: rare pickups a player claims onto their nearest creature. Spawn
// / despawn cadence + cap live on world_config (tunable via setPowerupConfig).
const powerup = table(
  { public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    x: t.u32(),
    y: t.u32(),
    kind: t.u8(), // 0 transmute, 1 speed_burst, 2 energy_surge, 3 clone, 4 hunger_zero
    spawnedAtTick: t.u64(),
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
    // Appended with a default so this is a migration-safe add -- existing
    // food rows on a live world become plankton (kind 0). See FOOD_KINDS.
    kind: t.u8().default(FOOD_KIND_PLANKTON),
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

// One row per visitor identity: how many food drops they've spent in the
// current window and when that window started. Public so the client can show
// a live "N left / resets in Xs" without a round-trip. Written only by
// placeFood.
const food_grant = table(
  { public: true },
  {
    owner: t.identity().primaryKey(),
    used: t.u32(),
    windowStart: t.timestamp(),
  }
);

// Retention mailing list. Private -- emails never go out over a client
// subscription; only the DB owner reads this (spacetime sql) to export.
// One row per identity, most-recent write wins (setPlayerEmail upserts).
const player_email = table(
  {},
  {
    owner: t.identity().primaryKey(),
    email: t.string(),
    source: t.string(), // 'landing_page' | 'game' | ...
    optedIn: t.bool(),
    updatedAt: t.timestamp(),
  }
);

const spacetimedb = schema({
  person,
  world_config,
  tick_schedule,
  creature,
  food,
  food_grant,
  powerup,
  player_email,
  event_log,
  llm_secret,
  terrain,
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
      size: STARTING_SIZE,
      ...DEFAULT_CREATURE_PARAMS,
      prompt: '(seed creature)',
      isPredator: false,
      kills: 0,
      owner: undefined,
      ...NO_EFFECTS,
    });
  }
  for (let i = 0; i < INITIAL_FOOD_COUNT; i++) {
    ctx.db.food.insert({ id: 0n, x: rng.int(GRID_SIZE), y: rng.int(GRID_SIZE), kind: FOOD_KIND_PLANKTON });
  }

  ctx.db.terrain.insert({ id: 0n, cells: generateTerrainCells(rng, GRID_SIZE) });

  // Inserted after the seeding draws above, so the stored seed reflects
  // state post-seeding rather than the raw timestamp-derived starting seed.
  ctx.db.world_config.insert({
    id: 0n,
    gridSize: GRID_SIZE,
    populationCap: DEFAULT_POPULATION_CAP,
    foodCap: DEFAULT_FOOD_CAP,
    bloomFoodMult: 2.0, bloomBurnMult: 1.0,
    coldFoodMult: 0.4, coldBurnMult: 0.6,
    ventFoodMult: 2.2, ventBurnMult: 1.5,
    barrenFoodMult: 0.0, barrenBurnMult: 1.0,
    foodSpawnPerTick: DEFAULT_FOOD_SPAWN_PER_TICK,
    tickIntervalMicros: TICK_INTERVAL_MICROS,
    minPopulation: DEFAULT_MIN_POPULATION,
    restockAmount: DEFAULT_RESTOCK_AMOUNT,
    powerupCap: DEFAULT_POWERUP_CAP,
    powerupSpawnEveryTicks: DEFAULT_POWERUP_SPAWN_EVERY_TICKS,
    powerupDespawnTicks: DEFAULT_POWERUP_DESPAWN_TICKS,
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
    ctx.db.person.insert({ name, owner: ctx.sender, createdAt: ctx.timestamp });
  }
);

// Retention email capture (landing-page signup, or added later in-game).
// Upserts one row per identity -- the most recent submission wins. Loose
// validation only: this is a mailing list, not an auth factor.
export const setPlayerEmail = spacetimedb.reducer(
  { email: t.string(), source: t.string(), optedIn: t.bool() },
  (ctx, { email, source, optedIn }) => {
    const trimmed = email.trim().slice(0, 254);
    const at = trimmed.indexOf('@');
    const dot = trimmed.indexOf('.', at + 2);
    if (at < 1 || dot < 0 || dot === trimmed.length - 1 || /\s/.test(trimmed)) {
      throw new SenderError("That doesn't look like an email address.");
    }
    const row = {
      owner: ctx.sender,
      email: trimmed,
      source: (source || 'unknown').slice(0, 40),
      optedIn,
      updatedAt: ctx.timestamp,
    };
    if (ctx.db.player_email.owner.find(ctx.sender)) {
      ctx.db.player_email.owner.update(row);
    } else {
      ctx.db.player_email.insert(row);
    }
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

// Tunable live: `spacetime call prompt-wars set_food_config 120 5 --server <env>`.
export const setFoodConfig = spacetimedb.reducer(
  { cap: t.u32(), spawnPerTick: t.u32() },
  (ctx, { cap, spawnPerTick }) => {
    const state = ctx.db.world_config.id.find(0n);
    if (!state) return;
    ctx.db.world_config.id.update({ ...state, foodCap: cap, foodSpawnPerTick: spawnPerTick });
  }
);

// Population floor: when the live population drops below `minPop`, `tick`
// restocks `restock` creatures (cloned from survivors, or defaults if the
// world is empty). Set restock to 0 to disable. CLI: `spacetime call
// prompt-wars set_population_floor 20 10 --server <env>`.
export const setPopulationFloor = spacetimedb.reducer(
  { minPop: t.u32(), restock: t.u32() },
  (ctx, { minPop, restock }) => {
    const state = ctx.db.world_config.id.find(0n);
    if (!state) return;
    ctx.db.world_config.id.update({ ...state, minPopulation: minPop, restockAmount: restock });
  }
);

// Powerup tuning, live: `spacetime call prompt-wars set_powerup_config 2 30 60
// --server <env>` (cap, spawn-every-N-ticks, despawn-after-N-ticks). Set cap
// to 0 to switch powerups off.
export const setPowerupConfig = spacetimedb.reducer(
  { cap: t.u32(), spawnEveryTicks: t.u32(), despawnTicks: t.u32() },
  (ctx, { cap, spawnEveryTicks, despawnTicks }) => {
    const state = ctx.db.world_config.id.find(0n);
    if (!state) return;
    ctx.db.world_config.id.update({
      ...state,
      powerupCap: cap,
      powerupSpawnEveryTicks: spawnEveryTicks,
      powerupDespawnTicks: despawnTicks,
    });
  }
);

// Player-dropped food. The browser calls this with a grid cell; the caller's
// identity (ctx.sender, never an argument) is rate-limited to
// PLAYER_FOOD_PER_WINDOW drops per rolling PLAYER_FOOD_WINDOW_MICROS. Drops
// are always plankton -- players help the ecosystem tick over, they don't get
// to seed the valuable mineral. Throws (surfaced to the UI) when the
// allowance is spent.
export const placeFood = spacetimedb.reducer(
  { x: t.u32(), y: t.u32() },
  (ctx, { x, y }) => {
    const state = ctx.db.world_config.id.find(0n);
    if (!state) return;
    if (x >= state.gridSize || y >= state.gridSize) {
      throw new SenderError('That spot is off the map.');
    }

    const now = ctx.timestamp;
    const grant = ctx.db.food_grant.owner.find(ctx.sender);
    if (!grant) {
      ctx.db.food_grant.insert({ owner: ctx.sender, used: 1, windowStart: now });
    } else {
      const elapsed = now.microsSinceUnixEpoch - grant.windowStart.microsSinceUnixEpoch;
      if (elapsed >= PLAYER_FOOD_WINDOW_MICROS) {
        ctx.db.food_grant.owner.update({ owner: ctx.sender, used: 1, windowStart: now });
      } else if (grant.used >= PLAYER_FOOD_PER_WINDOW) {
        const secsLeft = Number((PLAYER_FOOD_WINDOW_MICROS - elapsed) / 1_000_000n);
        throw new SenderError(`Out of food -- ${secsLeft}s until your next batch.`);
      } else {
        ctx.db.food_grant.owner.update({ ...grant, used: grant.used + 1 });
      }
    }

    ctx.db.food.insert({ id: 0n, x, y, kind: FOOD_KIND_PLANKTON });
  }
);

// Speed up or slow down the whole simulation live -- updates the real
// schedule (tick_schedule.scheduledAt, which actually controls firing rate)
// and world_config.tickIntervalMicros (a readable mirror the client uses to
// keep position-interpolation timing accurate) in the same call, so they
// can never drift apart. CLI: `spacetime call prompt-wars set_tick_speed
// 500000 --server <env>` (500,000 = 0.5s = 4x faster than the 2s default).
export const setTickSpeed = spacetimedb.reducer(
  { intervalMicros: t.u64() },
  (ctx, { intervalMicros }) => {
    const state = ctx.db.world_config.id.find(0n);
    if (!state) return;
    // tick_schedule.scheduledId is autoInc -- unlike world_config/terrain's
    // fixed id 0n, its real row id is whatever the DB assigned, so it must
    // be looked up rather than assumed to be 0n (that mismatch silently
    // no-opped the reschedule below while still writing the world_config
    // mirror, leaving the two out of sync).
    const schedule = [...ctx.db.tick_schedule.iter()][0];
    if (schedule) {
      ctx.db.tick_schedule.scheduledId.update({
        ...schedule,
        scheduledAt: ScheduleAt.interval(intervalMicros),
      });
    }
    ctx.db.world_config.id.update({ ...state, tickIntervalMicros: intervalMicros });
  }
);

// Grows (or shrinks) an already-running world live, without republishing —
// existing creature/food positions stay valid since they're always within
// [0, oldSize) which is a subset of any larger [0, newSize). Future
// movement/food-spawns immediately use the new bound (they read
// world_config.gridSize fresh each tick). Terrain is regenerated at the new
// size in the same call, since old terrain data doesn't cover the new area
// (and would be the wrong length for index math) either way. CLI:
// `spacetime call prompt-wars set_grid_size 80 --server <env>`.
export const setGridSize = spacetimedb.reducer(
  { size: t.u32() },
  (ctx, { size }) => {
    const state = ctx.db.world_config.id.find(0n);
    if (!state) return;
    const rng = makeRng(state.rngSeed);
    const cells = generateTerrainCells(rng, size);
    const existingTerrain = ctx.db.terrain.id.find(0n);
    if (existingTerrain) ctx.db.terrain.id.update({ ...existingTerrain, cells });
    else ctx.db.terrain.insert({ id: 0n, cells });
    ctx.db.world_config.id.update({ ...state, gridSize: size, rngSeed: rng.seed() });
  }
);

// Re-rolls terrain at the current grid size without changing anything else
// — used once to seed terrain on a world that predates this feature (no
// size change, so setGridSize's regeneration never ran), or any time you
// just want new terrain. CLI: `spacetime call prompt-wars regenerate_terrain
// --server <env>`.
export const regenerateTerrain = spacetimedb.reducer(ctx => {
  const state = ctx.db.world_config.id.find(0n);
  if (!state) return;
  const rng = makeRng(state.rngSeed);
  const cells = generateTerrainCells(rng, state.gridSize);
  const existing = ctx.db.terrain.id.find(0n);
  if (existing) ctx.db.terrain.id.update({ ...existing, cells });
  else ctx.db.terrain.insert({ id: 0n, cells });
  ctx.db.world_config.id.update({ ...state, rngSeed: rng.seed() });
});

// Retune one biome's pair of multipliers live. `biome` is the same index
// used in terrain.cells: 0 bloom, 1 cold shelf, 2 thermal vent, 3 barren.
// CLI: `spacetime call prompt-wars set_biome_multipliers 2 2.5 1.8 --server <env>`.
export const setBiomeMultipliers = spacetimedb.reducer(
  { biome: t.u8(), foodMult: t.f32(), burnMult: t.f32() },
  (ctx, { biome, foodMult, burnMult }) => {
    const state = ctx.db.world_config.id.find(0n);
    if (!state) return;
    switch (biome) {
      case BIOME_BLOOM:
        ctx.db.world_config.id.update({ ...state, bloomFoodMult: foodMult, bloomBurnMult: burnMult });
        break;
      case BIOME_COLD:
        ctx.db.world_config.id.update({ ...state, coldFoodMult: foodMult, coldBurnMult: burnMult });
        break;
      case BIOME_VENT:
        ctx.db.world_config.id.update({ ...state, ventFoodMult: foodMult, ventBurnMult: burnMult });
        break;
      case BIOME_BARREN:
        ctx.db.world_config.id.update({ ...state, barrenFoodMult: foodMult, barrenBurnMult: burnMult });
        break;
      default:
        throw new SenderError(`Unknown biome index ${biome} — expected 0-3.`);
    }
  }
);

// Manual predator spawn, for testing/demos -- normally predators only
// appear from ecological pressure in `tick` (see PREDATOR_SPAWN_POP_FOOD_RATIO).
// Still respects PREDATOR_MAX_ACTIVE: this is a way to trigger a spawn on
// demand, not a way around the population safety bound. CLI:
// `spacetime call prompt-wars spawn_predator --server <env>`.
export const spawnPredator = spacetimedb.reducer(ctx => {
  const state = ctx.db.world_config.id.find(0n);
  if (!state) return;
  const activePredators = [...ctx.db.creature.iter()].filter(c => c.isPredator).length;
  if (activePredators >= PREDATOR_MAX_ACTIVE) {
    throw new SenderError(
      `Already at the predator cap (${PREDATOR_MAX_ACTIVE}) — wait for one to despawn first.`
    );
  }
  const rng = makeRng(state.rngSeed);
  ctx.db.creature.insert({
    id: 0n,
    x: rng.int(state.gridSize),
    y: rng.int(state.gridSize),
    energy: PREDATOR_STARTING_ENERGY,
    size: PREDATOR_SIZE,
    glyph: PREDATOR_GLYPH,
    color: PREDATOR_COLOR,
    seeksFood: false,
    fleesLarger: false,
    aggression: 10,
    prompt: '(predator)',
    isPredator: true,
    kills: 0,
    owner: undefined,
    ...NO_EFFECTS,
  });
  ctx.db.world_config.id.update({ ...state, rngSeed: rng.seed() });
  ctx.db.event_log.insert({
    id: 0n,
    tickNumber: state.tickCount,
    message: 'A predator was manually spawned',
    at: ctx.timestamp,
  });
});

export const tick = spacetimedb.reducer(
  { onSchedule: tick_schedule },
  { timer: tick_schedule.rowType },
  (ctx, { timer: _timer }) => {
    const state = ctx.db.world_config.id.find(0n);
    if (!state) return;

    const rng = makeRng(state.rngSeed);
    const tickNumber = state.tickCount + 1n;
    const terrainCells = ctx.db.terrain.id.find(0n)?.cells;

    const creatures = [...ctx.db.creature.iter()];
    const foodByCell = new Map<string, { id: bigint; x: number; y: number; kind: number }>();
    for (const f of ctx.db.food.iter())
      foodByCell.set(`${f.x},${f.y}`, { id: f.id, x: f.x, y: f.y, kind: f.kind });
    // Snapshot for lineageName() in powerup-expiry log lines.
    const people: PersonSnapshot[] = [...ctx.db.person.iter()].map(p => ({
      name: p.name,
      owner: p.owner,
      createdAt: p.createdAt,
    }));

    let population = creatures.length;
    const logs: string[] = [];

    for (const current of creatures) {
      // `creatures` is a stale start-of-tick snapshot -- a predator earlier
      // in this same iteration may have already deleted this row (caught it
      // as prey) before its own turn comes up. Without this guard, the
      // normal-creature branch's update() at the end of this loop body
      // panics on an already-deleted row ("row was not found"). Same
      // simultaneity approximation as the flee/hunt searches: greedy,
      // tick-granular, no attempt at perfect ordering.
      if (!ctx.db.creature.id.find(current.id)) continue;

      // 0. Predators are world-spawned and behave entirely differently:
      // hunt the nearest smaller non-predator within radius, no food-
      // seeking, no fleeing, no reproduction. Handled as its own branch so
      // normal-creature logic below is completely untouched.
      if (current.isPredator) {
        let prey: { id: bigint; x: number; y: number } | undefined;
        let bestPreyDist = Infinity;
        for (const other of creatures) {
          if (other.id === current.id || other.isPredator) continue;
          if (other.size >= current.size) continue;
          const d = torusManhattan(current.x, current.y, other.x, other.y, state.gridSize);
          if (d <= PREDATOR_HUNT_RADIUS && d < bestPreyDist) {
            bestPreyDist = d;
            prey = other;
          }
        }

        let px = current.x;
        let py = current.y;
        if (prey) {
          const dx = torusDelta(px, prey.x, state.gridSize);
          const dy = torusDelta(py, prey.y, state.gridSize);
          if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) px += Math.sign(dx);
          else if (dy !== 0) py += Math.sign(dy);
        } else {
          const dir = rng.int(4);
          if (dir === 0) px += 1;
          else if (dir === 1) px -= 1;
          else if (dir === 2) py += 1;
          else py -= 1;
        }
        px = wrapCoord(px, state.gridSize);
        py = wrapCoord(py, state.gridSize);

        const predBiome = biomeAt(terrainCells, state.gridSize, px, py);
        const predBurnMult = multiplierForBiome(
          predBiome, state.bloomBurnMult, state.coldBurnMult, state.ventBurnMult, state.barrenBurnMult
        );
        let predEnergy = current.energy - PREDATOR_ENERGY_BURN_PER_TICK * predBurnMult;
        let kills = current.kills;

        // Catch: landed on the prey's tick-start position (same simultaneity
        // approximation the flee search above already makes -- greedy,
        // tick-granular, no pathfinding) and the prey row still exists (it
        // may already have died or been caught by this same tick).
        if (prey && px === prey.x && py === prey.y) {
          const stillThere = ctx.db.creature.id.find(prey.id);
          if (stillThere && !stillThere.isPredator) {
            ctx.db.creature.id.delete(prey.id);
            population--;
            predEnergy = Math.min(MAX_ENERGY, predEnergy + PREDATOR_ENERGY_FROM_KILL);
            kills++;
            logs.push(`A predator caught "${truncate(stillThere.prompt, 50)}"`);
          }
        }

        if (predEnergy <= 0 || kills >= PREDATOR_MAX_KILLS) {
          ctx.db.creature.id.delete(current.id);
          population--;
          logs.push(
            kills >= PREDATOR_MAX_KILLS ? 'A predator moved on, sated' : 'A predator starved and vanished'
          );
          continue;
        }

        ctx.db.creature.id.update({ ...current, x: px, y: py, energy: predEnergy, kills });
        continue;
      }

      // 0b. Powerup effects. Each *UntilTick holds the tick the effect ends
      // on; while active it modifies this tick, and the first tick past it we
      // clear the timer and log that it wore off.
      let speedUntilTick = current.speedUntilTick;
      let surgeUntilTick = current.surgeUntilTick;
      let hungerZeroUntilTick = current.hungerZeroUntilTick;
      const speedActive = speedUntilTick > tickNumber;
      const surgeActive = surgeUntilTick > tickNumber;
      const hungerZeroActive = hungerZeroUntilTick > tickNumber;
      if (speedUntilTick !== 0n && tickNumber >= speedUntilTick) {
        speedUntilTick = 0n;
        logs.push(`→ ${lineageName(people, current.owner, current.id)}'s Speed Burst wore off`);
      }
      if (surgeUntilTick !== 0n && tickNumber >= surgeUntilTick) {
        surgeUntilTick = 0n;
        logs.push(`→ ${lineageName(people, current.owner, current.id)}'s Energy Surge wore off`);
      }
      if (hungerZeroUntilTick !== 0n && tickNumber >= hungerZeroUntilTick) {
        hungerZeroUntilTick = 0n;
        logs.push(`→ ${lineageName(people, current.owner, current.id)} left its Hunger Zero rest`);
      }

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
          const d = torusManhattan(current.x, current.y, other.x, other.y, state.gridSize);
          if (d <= FLEE_RADIUS && d < bestThreatDist) {
            bestThreatDist = d;
            fleeFrom = other;
          }
        }
      }

      let target: { x: number; y: number } | undefined;
      // Hunger Zero: ignore food entirely, just wander (a "rest" state).
      if (!fleeFrom && current.seeksFood && !hungerZeroActive) {
        let bestDist = Infinity;
        for (const f of foodByCell.values()) {
          const d = torusManhattan(current.x, current.y, f.x, f.y, state.gridSize);
          if (d < bestDist) {
            bestDist = d;
            target = f;
          }
        }
      }

      // 2. Move toward the food target, away from a threat, or a random step
      // if neither applies (greedy either way, no pathfinding). Speed Burst
      // takes two steps instead of one.
      let x = current.x;
      let y = current.y;
      const steps = speedActive ? 2 : 1;
      for (let s = 0; s < steps; s++) {
        if (fleeFrom) {
          const dx = torusDelta(fleeFrom.x, x, state.gridSize); // heading away from the threat
          const dy = torusDelta(fleeFrom.y, y, state.gridSize);
          if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) x += Math.sign(dx);
          else if (dy !== 0) y += Math.sign(dy);
          else x += rng.int(2) === 0 ? 1 : -1; // directly on top of the threat
        } else if (target) {
          const dx = torusDelta(x, target.x, state.gridSize);
          const dy = torusDelta(y, target.y, state.gridSize);
          if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) x += Math.sign(dx);
          else if (dy !== 0) y += Math.sign(dy);
        } else {
          const dir = rng.int(4);
          if (dir === 0) x += 1;
          else if (dir === 1) x -= 1;
          else if (dir === 2) y += 1;
          else y -= 1;
        }
      }
      x = wrapCoord(x, state.gridSize);
      y = wrapCoord(y, state.gridSize);

      // 3. Eat if standing on food; otherwise burn energy, and shrink if
      // starving. Aggression trades burn rate for gain rate either way —
      // no free lunch for a "voracious" creature. Burn is also scaled by
      // the biome the creature just moved into — a cold shelf is cheap to
      // live on, a thermal vent is expensive.
      const biomeHere = biomeAt(terrainCells, state.gridSize, x, y);
      const burnMult = multiplierForBiome(
        biomeHere, state.bloomBurnMult, state.coldBurnMult, state.ventBurnMult, state.barrenBurnMult
      );
      const aggressionScale = 1 + current.aggression * AGGRESSION_ENERGY_SCALE;
      const surgeBurn = surgeActive ? ENERGY_SURGE_BURN_MULT : 1;
      let energy = current.energy - ENERGY_BURN_PER_TICK * aggressionScale * burnMult * surgeBurn;
      let size = current.size;
      const cellKey = `${x},${y}`;
      const eaten = foodByCell.get(cellKey);
      if (eaten) {
        // Resource conflict. Any other non-predator whose tick-start position
        // is within one cell of this morsel could be reaching for it too
        // (creatures move at most one cell per tick). Higher contestScore
        // wins; an exact tie breaks to the lower id. A loser simply doesn't
        // eat this tick -- it already paid the move-energy cost, and the food
        // stays put for the winner, who takes it on their own turn in this
        // same loop or on the next tick.
        const myScore = contestScore(current);
        let rivalId: bigint | undefined;
        for (const other of creatures) {
          if (other.id === current.id || other.isPredator) continue;
          if (torusManhattan(other.x, other.y, x, y, state.gridSize) > 1) continue;
          if (!ctx.db.creature.id.find(other.id)) continue; // died/eaten already this tick
          const otherScore = contestScore(other);
          if (otherScore > myScore || (otherScore === myScore && other.id < current.id)) {
            rivalId = other.id;
            break;
          }
        }
        if (rivalId === undefined) {
          const fk = FOOD_KINDS[eaten.kind] ?? FOOD_KINDS[FOOD_KIND_PLANKTON];
          energy = Math.min(MAX_ENERGY, energy + fk.energy * aggressionScale);
          size = Math.min(MAX_SIZE, size + fk.growth);
          ctx.db.food.id.delete(eaten.id);
          foodByCell.delete(cellKey);
        } else if (eaten.kind === FOOD_KIND_MINERAL) {
          // Only the valuable morsel's fights are worth a log line.
          logs.push(`Creature #${current.id} was shoved off a mineral by #${rivalId}`);
        }
      } else if (energy < STARVING_ENERGY_THRESHOLD) {
        size = Math.max(MIN_SIZE, size - SIZE_SHRINK_PER_TICK);
      }

      // 3b. Cross-species predation: a much bigger, not-timid creature that
      // ended its move touching a smaller one eats it (one per tick). A
      // Hunger Zero creature is resting and doesn't.
      if (!hungerZeroActive && current.aggression >= CANNIBAL_MIN_AGGRESSION) {
        for (const other of creatures) {
          if (other.id === current.id || other.isPredator) continue;
          if (size < other.size * CANNIBAL_SIZE_RATIO) continue;
          if (torusManhattan(other.x, other.y, x, y, state.gridSize) > 1) continue;
          if (!ctx.db.creature.id.find(other.id)) continue; // already gone this tick
          ctx.db.creature.id.delete(other.id);
          population--;
          energy = Math.min(MAX_ENERGY, energy + ENERGY_FROM_PREY);
          size = Math.min(MAX_SIZE, size + SIZE_GROWTH_PER_MEAL);
          logs.push(`${lineageName(people, current.owner, current.id)} devoured a smaller creature`);
          break;
        }
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
          isPredator: false,
          kills: 0,
          owner: current.owner,
          ...NO_EFFECTS,
        });
        population++;
        logs.push(
          `Creature #${current.id} reproduced -> #${child.id} (size ${childSize.toFixed(2)})`
        );
      }

      ctx.db.creature.id.update({
        ...current,
        x,
        y,
        energy,
        size,
        speedUntilTick,
        surgeUntilTick,
        hungerZeroUntilTick,
      });
    }

    // Keep food topped up to the cap, biome-weighted: a candidate cell's
    // biome food multiplier is the probability (clamped to 1) that a spawn
    // attempt there actually succeeds, so barren (mult 0) never spawns food
    // and a thermal vent (mult 2.2) usually does. Bounded retry count keeps
    // this O(1) even when many candidates land on low-multiplier biomes.
    let foodCount = foodByCell.size;
    let spawned = 0;
    let attempts = 0;
    const maxAttempts = state.foodSpawnPerTick * 4;
    while (spawned < state.foodSpawnPerTick && foodCount < state.foodCap && attempts < maxAttempts) {
      attempts++;
      const fx = rng.int(state.gridSize);
      const fy = rng.int(state.gridSize);
      const fbiome = biomeAt(terrainCells, state.gridSize, fx, fy);
      const foodMult = multiplierForBiome(
        fbiome,
        state.bloomFoodMult, state.coldFoodMult, state.ventFoodMult, state.barrenFoodMult
      );
      if (rng.next() < Math.min(1, foodMult * 0.5)) {
        ctx.db.food.insert({ id: 0n, x: fx, y: fy, kind: pickFoodKind(rng, fbiome) });
        foodCount++;
        spawned++;
      }
    }

    // Predator spawning: driven by ecological pressure (population
    // outstripping food supply), not a timer -- ties predators to the same
    // overcrowding logic as starvation/reproduction instead of being an
    // arbitrary bolt-on. Bounded by PREDATOR_MAX_ACTIVE regardless of how
    // overcrowded things get, and PREDATOR_MIN_POPULATION_TO_SPAWN guards
    // against culling an already-struggling world further.
    const overcrowded =
      population >= PREDATOR_MIN_POPULATION_TO_SPAWN &&
      population / Math.max(1, foodCount) > PREDATOR_SPAWN_POP_FOOD_RATIO;
    if (overcrowded) {
      const activePredators = [...ctx.db.creature.iter()].filter(c => c.isPredator).length;
      if (activePredators < PREDATOR_MAX_ACTIVE) {
        ctx.db.creature.insert({
          id: 0n,
          x: rng.int(state.gridSize),
          y: rng.int(state.gridSize),
          energy: PREDATOR_STARTING_ENERGY,
          size: PREDATOR_SIZE,
          glyph: PREDATOR_GLYPH,
          color: PREDATOR_COLOR,
          seeksFood: false,
          fleesLarger: false,
          aggression: 10,
          prompt: '(predator)',
          isPredator: true,
          kills: 0,
          owner: undefined,
          ...NO_EFFECTS,
        });
        logs.push('A predator has appeared -- the population outgrew its food supply');
      }
    }

    // Population floor: if the world has thinned past minPopulation, top it
    // back up so it can't spiral to zero unattended. Each restocked creature
    // echoes a random survivor's lineage (glyph/colour/behaviour) with a
    // small size mutation -- a world that found a working niche repopulates
    // with more of it -- and starts well-fed so the top-up actually takes.
    // With no survivors at all it falls back to plain defaults, so the world
    // always recovers even from a total wipe.
    if (population < state.minPopulation && population < state.populationCap) {
      const survivors = [...ctx.db.creature.iter()].filter(c => !c.isPredator);
      const want = Math.min(state.restockAmount, state.populationCap - population);
      const before = population;
      for (let i = 0; i < want; i++) {
        const parent = survivors.length > 0 ? survivors[rng.int(survivors.length)] : undefined;
        const mutation = 1 + (rng.next() * 2 - 1) * MUTATION_RANGE;
        ctx.db.creature.insert({
          id: 0n,
          x: rng.int(state.gridSize),
          y: rng.int(state.gridSize),
          energy: RESTOCK_STARTING_ENERGY,
          size: parent ? clamp(parent.size * mutation, MIN_SIZE, MAX_SIZE) : STARTING_SIZE,
          glyph: parent ? parent.glyph : DEFAULT_CREATURE_PARAMS.glyph,
          color: parent ? parent.color : DEFAULT_CREATURE_PARAMS.color,
          seeksFood: parent ? parent.seeksFood : DEFAULT_CREATURE_PARAMS.seeksFood,
          fleesLarger: parent ? parent.fleesLarger : DEFAULT_CREATURE_PARAMS.fleesLarger,
          aggression: parent ? parent.aggression : DEFAULT_CREATURE_PARAMS.aggression,
          prompt: parent ? parent.prompt : '(restock)',
          isPredator: false,
          kills: 0,
          owner: undefined,
          ...NO_EFFECTS,
        });
        population++;
      }
      if (population > before) {
        logs.push(`Population fell to ${before} -- restocked ${population - before} creatures`);
      }
    }

    // --- Powerups: despawn stale ones, then maybe spawn a fresh one -------
    {
      let active = 0;
      for (const pu of ctx.db.powerup.iter()) {
        if (tickNumber - pu.spawnedAtTick >= BigInt(state.powerupDespawnTicks)) {
          ctx.db.powerup.id.delete(pu.id);
          logs.push(`✦ A ${POWERUP_LABELS[pu.kind] ?? 'mystery'} powerup faded away`);
        } else {
          active++;
        }
      }
      const every = BigInt(Math.max(1, state.powerupSpawnEveryTicks));
      if (tickNumber % every === 0n && active < state.powerupCap) {
        const biome = rng.int(BIOME_COUNT);
        const pos = pickSpawnPosition(rng, terrainCells, state.gridSize, biome);
        const kind = rng.int(POWERUP_KIND_COUNT);
        ctx.db.powerup.insert({ id: 0n, x: pos.x, y: pos.y, kind, spawnedAtTick: tickNumber });
        logs.push(`✦ ${POWERUP_LABELS[kind]} powerup appeared at (${pos.x}, ${pos.y})`);
      }
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
    let habitatBiome = -1; // -1 = no preference -> uniform random position

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
            max_tokens: LLM_MAX_TOKENS,
            reasoning_effort: 'low', // this is a reasoning model — keep it terse and fast
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
            const parsed = JSON.parse(stripJsonFences(content));
            params = clampCreatureParams(parsed);
            habitatBiome = clampHabitat(parsed);
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
      const terrainCells = tx.db.terrain.id.find(0n)?.cells;
      const pos = pickSpawnPosition(rng, terrainCells, state.gridSize, habitatBiome);
      const row = tx.db.creature.insert({
        id: 0n,
        x: pos.x,
        y: pos.y,
        energy: CHILD_STARTING_ENERGY,
        size: STARTING_SIZE,
        glyph: params.glyph,
        color: params.color,
        seeksFood: params.seeksFood,
        fleesLarger: params.fleesLarger,
        aggression: params.aggression,
        prompt: trimmedPrompt,
        isPredator: false,
        kills: 0,
        owner: ctx.sender,
        ...NO_EFFECTS,
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
    return { creatureId: child.id, summary: describeCreatureParams(params, habitatBiome) };
  }
);

const ClaimResult = t.object('ClaimResult', {
  ok: t.bool(),
  message: t.string(),
});

// Claim a powerup onto the caller's nearest own creature. A procedure (not a
// reducer) because Transmute needs the LLM compile call; the other four kinds
// are pure table writes done in ctx.withTx. Targeting + all validation happen
// server-side against ctx.sender — the client only sends a powerup id.
export const claimPowerup = spacetimedb.procedure(
  { powerupId: t.u64() },
  ClaimResult,
  (ctx, { powerupId }) => {
    const setup = ctx.withTx(tx => {
      const pu = tx.db.powerup.id.find(powerupId);
      if (!pu) return { error: 'That powerup is already gone.' };
      const cfg = tx.db.world_config.id.find(0n);
      const gs = cfg ? cfg.gridSize : 300;
      const mine = [...tx.db.creature.iter()].filter(
        c => !c.isPredator && c.owner && c.owner.equals(ctx.sender)
      );
      if (mine.length === 0) return { error: 'No creature nearby to claim this powerup.' };
      let nearest = mine[0];
      let best = torusManhattan(nearest.x, nearest.y, pu.x, pu.y, gs);
      for (const c of mine) {
        const d = torusManhattan(c.x, c.y, pu.x, pu.y, gs);
        if (d < best) {
          best = d;
          nearest = c;
        }
      }
      if (best > POWERUP_CLAIM_RADIUS) {
        return { error: 'No creature nearby to claim this powerup.' };
      }
      const people: PersonSnapshot[] = [...tx.db.person.iter()].map(p => ({
        name: p.name,
        owner: p.owner,
        createdAt: p.createdAt,
      }));
      const state = tx.db.world_config.id.find(0n);
      return {
        kind: pu.kind,
        nearestId: nearest.id,
        name: lineageName(people, nearest.owner, nearest.id),
        tickNumber: state ? state.tickCount : 0n,
      };
    });
    if ('error' in setup) return { ok: false, message: String(setup.error) };

    const { kind, nearestId, name, tickNumber } = setup;
    const label = POWERUP_LABELS[kind] ?? 'Powerup';

    // Transmute: reroll traits via the same LLM compile path as spawn. Do the
    // fetch OUTSIDE any transaction; fall back to a random-ish local reroll if
    // there's no key or the call fails.
    let rerolled: CreatureParams | undefined;
    let rerolledHabitat = -1;
    if (kind === 0) {
      const secret = ctx.withTx(tx => tx.db.llm_secret.id.find(0n));
      if (secret) {
        try {
          const res = ctx.http.fetch(GROK_API_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${secret.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model: GROK_MODEL,
              max_tokens: LLM_MAX_TOKENS,
              reasoning_effort: 'low',
              messages: [
                { role: 'system', content: CREATURE_COMPILE_SYSTEM_PROMPT },
                { role: 'user', content: 'a random creature — surprising, distinct, any habitat' },
              ],
            }),
            timeout: TimeDuration.fromMillis(LLM_TIMEOUT_MILLIS),
          });
          if (res.status === 200) {
            const content = JSON.parse(res.text())?.choices?.[0]?.message?.content;
            if (typeof content === 'string') {
              const parsed = JSON.parse(stripJsonFences(content));
              rerolled = clampCreatureParams(parsed);
              rerolledHabitat = clampHabitat(parsed);
            }
          }
        } catch {
          // fall through to the local reroll below
        }
      }
    }

    const result = ctx.withTx(tx => {
      const pu = tx.db.powerup.id.find(powerupId);
      if (!pu) return 'That powerup was just taken.';
      const c = tx.db.creature.id.find(nearestId);
      if (!c) return 'Your creature is no longer around.';
      const state = tx.db.world_config.id.find(0n);
      if (!state) return 'World not ready.';
      const rng = makeRng(state.rngSeed);
      tx.db.powerup.id.delete(pu.id);

      const logEvent = (message: string) =>
        tx.db.event_log.insert({ id: 0n, tickNumber, message, at: ctx.timestamp });

      if (kind === 0) {
        const next: CreatureParams = rerolled ?? {
          seeksFood: rng.next() > 0.3,
          fleesLarger: rng.next() > 0.5,
          aggression: rng.int(11),
          glyph: DEFAULT_CREATURE_PARAMS.glyph,
          color: DEFAULT_CREATURE_PARAMS.color,
        };
        const before = describeCreatureParams(
          {
            seeksFood: c.seeksFood,
            fleesLarger: c.fleesLarger,
            aggression: c.aggression,
            glyph: c.glyph,
            color: c.color,
          },
          -1
        );
        tx.db.creature.id.update({
          ...c,
          glyph: next.glyph,
          color: next.color,
          seeksFood: next.seeksFood,
          fleesLarger: next.fleesLarger,
          aggression: next.aggression,
          energy: TRANSMUTE_RESET_ENERGY,
          prompt: '(transmuted) a random creature',
          speedUntilTick: 0n,
          surgeUntilTick: 0n,
          hungerZeroUntilTick: 0n,
        });
        tx.db.world_config.id.update({ ...state, rngSeed: rng.seed() });
        logEvent(`→ ${name} used Transmute! Was: ${before} Now: ${describeCreatureParams(next, rerolledHabitat)}`);
        return null;
      }

      if (kind === 1) {
        tx.db.creature.id.update({ ...c, speedUntilTick: tickNumber + SPEED_BURST_TICKS });
        logEvent(`→ ${name} gained Speed Burst! Racing for ${SPEED_BURST_TICKS} ticks`);
        return null;
      }

      if (kind === 2) {
        tx.db.creature.id.update({
          ...c,
          energy: Math.min(MAX_ENERGY, c.energy + ENERGY_SURGE_BONUS),
          surgeUntilTick: tickNumber + ENERGY_SURGE_TICKS,
        });
        logEvent(`→ ${name} got an Energy Surge! (will starve fast after)`);
        return null;
      }

      if (kind === 3) {
        const living = [...tx.db.creature.iter()];
        if (living.length >= state.populationCap) {
          let victim = living[0];
          for (const other of living) if (other.id < victim.id) victim = other;
          tx.db.creature.id.delete(victim.id);
          logEvent(`Creature #${victim.id} starved to make room for a clone`);
        }
        const { id: _id, ...rest } = c;
        tx.db.creature.insert({ ...rest, id: 0n });
        logEvent(`→ ${name} used Clone! Spawned duplicate`);
        return null;
      }

      // kind 4: hunger_zero
      tx.db.creature.id.update({ ...c, hungerZeroUntilTick: tickNumber + HUNGER_ZERO_TICKS });
      logEvent(`→ ${name} entered Hunger Zero state (meditating for ${HUNGER_ZERO_TICKS} ticks)`);
      return null;
    });

    if (typeof result === 'string') return { ok: false, message: result };
    return { ok: true, message: `${name} used ${label}` };
  }
);
