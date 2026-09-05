# Architecture — where do I change what

One file for the whole simulation right now: `spacetimedb/src/index.ts`. Don't split it
into `schema.ts` + reducers until it actually hurts to scroll — see "Why one file" below.

| I want to change... | Look at |
|---|---|
| Tick speed | `TICK_INTERVAL_MICROS`, top of `spacetimedb/src/index.ts` |
| Grid size | `GRID_SIZE` constant (same file) — also stored on `world_config.gridSize` so reducer code has one source of truth instead of a second hardcoded literal |
| Population cap | `DEFAULT_POPULATION_CAP` for the value new worlds start with; change it live on a running world without republishing via `spacetime call prompt-wars set_population_cap <N> --server local` (note: snake_case on the CLI, not the camelCase export name — see README gotchas) |
| Food cap / spawn rate | `DEFAULT_FOOD_CAP`, `FOOD_SPAWN_PER_TICK` |
| How creatures move | the "find nearest food" + "move one cell toward it" block inside the `tick` reducer body |
| Energy/size rules (gain, burn, starve, grow, shrink, die) | the constants block (`ENERGY_*`, `SIZE_*`, `STARVING_ENERGY_THRESHOLD`, `MIN_SIZE`/`MAX_SIZE`) plus the per-creature loop in `tick` |
| Reproduction / mutation | `REPRODUCE_ENERGY_THRESHOLD`, `REPRODUCE_ENERGY_COST`, `CHILD_STARTING_ENERGY`, `MUTATION_RANGE`, and the reproduction block in `tick` |
| Determinism / RNG | `makeRng()` — a seeded xorshift64*, deliberately not `ctx.random()`. The seed lives on `world_config.rngSeed` and is advanced exactly once per tick, then written back |
| What counts as a "significant event" in the log | the `logs.push(...)` calls in `tick` (currently: births, deaths) — the trim-to-50 logic right after doesn't need touching |
| The visual grid / counts / recent events | `app/WorldView.tsx` — a colored `<pre>` ASCII grid (one creature's `glyph`/`color` per cell), no styling beyond that |
| The LLM prompt / how a description compiles into behavior | `CREATURE_COMPILE_SYSTEM_PROMPT` (what Grok is asked for) + `clampCreatureParams` (what happens to what it returns) + `DEFAULT_CREATURE_PARAMS` (the fallback), all in `spacetimedb/src/index.ts` |
| Which LLM / model | `GROK_API_URL`, `GROK_MODEL` — verify the model id against https://docs.x.ai/docs/models before trusting it |
| The LLM key itself | `spacetime call prompt-wars set_llm_key '"<key>"' --server local` (and again with `--server maincloud` for that environment) — first caller becomes the permanent owner, see CLAUDE.md |
| How a compiled param actually changes behavior | `seeksFood`/`fleesLarger` in the movement block, `aggression` via `AGGRESSION_ENERGY_SCALE` in the energy block — all inside the per-creature loop in `tick` |
| The spawn form / plain-language result text | `app/SpawnCreature.tsx` — `useProcedure(procedures.spawnFromPrompt)`, renders the returned `summary` |
| Per-creature glyph/color, plain-language behavior summary | `describeCreatureParams()` (the summary text) and the `creature.glyph`/`creature.color` columns (the visual), both in `spacetimedb/src/index.ts` |

## Why one file

Splitting `spacetimedb/src/index.ts` into `schema.ts` + reducer files early costs you a
context-switch every time you touch gameplay, for a benefit (avoiding scroll) you don't
have yet — it's a few hundred lines including the LLM spawn path. If it grows past a
couple screens, split tables into `schema.ts` and re-export the default from `index.ts`:

```typescript
// index.ts
export { default } from './schema';
```

Not before then.

## A performance note, in case you scale the caps up later

Each tick, every creature searches every food cell for the nearest one (`O(population ×
food)`), and a `fleesLarger` creature does the same over other creatures — neither is
spatial-indexed. At the current caps (20 population, 25 food, on a 20×20 grid) that's a
few hundred comparisons per tick at most, trivial. If you raise either cap by an order
of magnitude, this is the first thing to revisit (a grid-cell bucket index, or just
capping the search radius) — not before, since it isn't the bottleneck at this scale and
a spatial index is real complexity you don't need yet.
