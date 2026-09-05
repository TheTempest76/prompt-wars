# Architecture — where do I change what

One file for the whole simulation right now: `spacetimedb/src/index.ts`. Don't split it
into `schema.ts` + reducers until it actually hurts to scroll — see "Why one file" below.

| I want to change... | Look at |
|---|---|
| Tick speed | `TICK_INTERVAL_MICROS`, top of `spacetimedb/src/index.ts` |
| Grid size | `GRID_SIZE` constant seeds *fresh* installs only; grow/shrink an already-running world with `spacetime call prompt-wars set_grid_size <N> --server <env>` (no republish, no wipe — existing positions stay valid, future movement/food-spawns pick up the new bound next tick). Client never hardcodes it — always reads `world_config.gridSize` |
| Population cap | `DEFAULT_POPULATION_CAP` for the value new worlds start with; change it live on a running world without republishing via `spacetime call prompt-wars set_population_cap <N> --server local` (note: snake_case on the CLI, not the camelCase export name — see README gotchas) |
| Food cap / spawn rate | `DEFAULT_FOOD_CAP`, `FOOD_SPAWN_PER_TICK` |
| How creatures move | the "find nearest food" + "move one cell toward it" block inside the `tick` reducer body |
| Energy/size rules (gain, burn, starve, grow, shrink, die) | the constants block (`ENERGY_*`, `SIZE_*`, `STARVING_ENERGY_THRESHOLD`, `MIN_SIZE`/`MAX_SIZE`) plus the per-creature loop in `tick` |
| Reproduction / mutation | `REPRODUCE_ENERGY_THRESHOLD`, `REPRODUCE_ENERGY_COST`, `CHILD_STARTING_ENERGY`, `MUTATION_RANGE`, and the reproduction block in `tick` |
| Determinism / RNG | `makeRng()` — a seeded xorshift64*, deliberately not `ctx.random()`. The seed lives on `world_config.rngSeed` and is advanced exactly once per tick, then written back |
| What counts as a "significant event" in the log | the `logs.push(...)` calls in `tick` (currently: births, deaths) — the trim-to-50 logic right after doesn't need touching |
| Counts / recent events (the text info panel) | `app/WorldView.tsx` — subscribes to all four tables, passes `creatures`/`food`/`gridSize` down as props to `WorldCanvas` |
| The world's visual rendering (canvas, camera, pan/zoom, interpolation) | `app/WorldCanvas.tsx` — see its own section below, it's substantial enough to warrant one |
| The LLM prompt / how a description compiles into behavior | `CREATURE_COMPILE_SYSTEM_PROMPT` (what Groq is asked for — placeholders in it must look unmistakably like placeholders, not valid JSON, or the model echoes them literally) + `clampCreatureParams` (what happens to what it returns) + `DEFAULT_CREATURE_PARAMS` (the fallback), all in `spacetimedb/src/index.ts` |
| Which LLM / model | `GROK_API_URL` (actually Groq — `api.groq.com`, not xAI), `GROK_MODEL` — verify against https://console.groq.com/docs/models; if it's a reasoning model (most are), also check `LLM_MAX_TOKENS` and `reasoning_effort` have enough room |
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
spatial-indexed. At the current caps (20 population, 25 food, on an 80×80 grid) that's a
few hundred comparisons per tick at most, trivial. If you raise either cap by an order
of magnitude, this is the first thing to revisit (a grid-cell bucket index, or just
capping the search radius) — not before, since it isn't the bottleneck at this scale and
a spatial index is real complexity you don't need yet. Note the grid growing to 80×80
made the world sparser (same 20/25 caps over 16× the area) — deliberate, not scaled up
with it, since this pass was about the renderer, not rebalancing population density;
`set_population_cap`/`set_food_cap`-equivalent tuning is a separate, later call.

## `app/WorldCanvas.tsx` — the canvas renderer

Takes `gridSize`/`creatures`/`food` as props from `WorldView` (no subscriptions of its
own). Everything it needs to touch:

| I want to change... | Look at |
|---|---|
| Canvas/container size, aspect ratio | the `containerRef` `<div>`'s inline style (`aspectRatio: '1'`, `maxHeight: '75vh'`) — actual pixel sizing itself happens in the `ResizeObserver` callback, don't touch that math |
| Camera pan/zoom feel from keyboard | `PAN_SPEED`, `ZOOM_SPEED` |
| Zoom limits | `MIN_ZOOM_ABS` (absolute floor) and `MAX_ZOOM`; the *effective* min is recomputed on every layout change as a fraction of fit-zoom, in `fitCamera` |
| How far you can pan past the world's edge | the `margin` calculation in `clampCamera` |
| Creature circle size / glow / outline | the per-creature draw block inside `draw()` — `radius`, the `createRadialGradient` call, the stroke at the end |
| Food dot appearance | the food loop in `draw()`, just above the creature loop |
| Position interpolation (the tick-to-tick lerp) | the `useEffect` watching `creatures` (builds `interpRef`) + the `t = ...` line inside `draw()`. `TICK_INTERVAL_MS` must match the server's real tick interval (`TICK_INTERVAL_MICROS` in `spacetimedb/src/index.ts`) or creatures will lerp too fast/slow relative to when the next tick actually lands |
| Pan/pinch behavior | `onPointerDown`/`onPointerMove`/`endPointer` — pan is the 1-pointer branch, pinch-to-zoom-around-midpoint is the 2-pointer branch |
| Keyboard bindings | the key-name arrays in the `keydown` handler and the `loop()` function's key-to-`dx/dy/zoomMul` mapping |

Three things it deliberately does *not* do, so a future change doesn't accidentally
reintroduce them: no game engine/scene graph (`draw()` is one flat function issuing
Canvas 2D calls), no animation easing beyond the position lerp (zoom/pan themselves are
never eased, only creature movement is), and no per-frame React re-render for drawing
(the `requestAnimationFrame` loop reads everything through refs — `cameraRef`,
`foodRef`, `gridSizeRef`, `interpRef` — so `draw()` never needs recreating and drawing
is fully decoupled from React's render cycle; only pan/zoom/keyboard *inputs* go through
`setCamera`, which is intentionally kept as real React state per the actual requirement).
