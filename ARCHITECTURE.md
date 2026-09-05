# Architecture — where do I change what

One file for the whole simulation right now: `spacetimedb/src/index.ts`. Don't split it
into `schema.ts` + reducers until it actually hurts to scroll — see "Why one file" below.

| I want to change... | Look at |
|---|---|
| Tick speed | `TICK_INTERVAL_MICROS` (top of `spacetimedb/src/index.ts`) seeds *fresh* installs only; retune a running world live with `spacetime call prompt-wars set_tick_speed <micros> --server <env>` — it updates `tick_schedule`'s actual `scheduledAt` and the `world_config.tickIntervalMicros` client-readable mirror together, so they can't drift. The client (`app/WorldView.tsx` → `app/WorldCanvas.tsx`'s `tickIntervalMs` prop) reads the mirror to keep position interpolation accurate at whatever speed the tick is really running |
| Grid size | `GRID_SIZE` constant (currently 300) seeds *fresh* installs only; grow/shrink an already-running world with `spacetime call prompt-wars set_grid_size <N> --server <env>` (no republish, no wipe — existing positions stay valid, future movement/food-spawns pick up the new bound next tick). Client never hardcodes it — always reads `world_config.gridSize`. If you change this a lot, also revisit `FLEE_RADIUS`/`PREDATOR_HUNT_RADIUS` (see below) — they're fixed cell counts tuned for 300, not gridSize-relative, so a much smaller or bigger grid changes how effective they are |
| Population cap | `DEFAULT_POPULATION_CAP` (currently 50) for the value new worlds start with; change it live on a running world without republishing via `spacetime call prompt-wars set_population_cap <N> --server local` (note: snake_case on the CLI, not the camelCase export name — see README gotchas) |
| Food cap / spawn rate | Both live on `world_config` now (`foodCap`, `foodSpawnPerTick`, currently 350/15) — `DEFAULT_FOOD_CAP`/`DEFAULT_FOOD_SPAWN_PER_TICK` only seed fresh installs; retune a running world with `spacetime call prompt-wars set_food_config <cap> <spawnPerTick> --server <env>`. These are tied to `GRID_SIZE` in practice even though nothing enforces it in code — a much bigger grid needs more food or the population starves reaching for it (this happened once already, see README gotchas) |
| Predator ecology (spawn threshold, hunt range, kill/energy limits) | the `PREDATOR_*` constants block in `spacetimedb/src/index.ts` — see the dedicated table entry below |
| Manually spawning a predator (not the ecological trigger) | `spacetime call prompt-wars spawn_predator --server <env>` (no args) — the `spawnPredator` reducer in `spacetimedb/src/index.ts`, gated by the same `PREDATOR_MAX_ACTIVE` cap as the automatic trigger so it can't bypass the bounded-lifespan design |
| How creatures move | the "find nearest food" + "move one cell toward it" block inside the `tick` reducer body |
| Energy/size rules (gain, burn, starve, grow, shrink, die) | the constants block (`ENERGY_*`, `SIZE_*`, `STARVING_ENERGY_THRESHOLD`, `MIN_SIZE`/`MAX_SIZE`) plus the per-creature loop in `tick`. For "how dramatic does growth look on screen," the two that matter are `SIZE_GROWTH_PER_MEAL` (currently `0.15`) and `MAX_SIZE` (`3`, vs. a starting size of `1`) — tuned together so growth is visible within a normal session, not just present in the data |
| Reproduction / mutation | `REPRODUCE_ENERGY_THRESHOLD`, `REPRODUCE_ENERGY_COST`, `CHILD_STARTING_ENERGY`, `MUTATION_RANGE`, and the reproduction block in `tick` |
| Determinism / RNG | `makeRng()` — a seeded xorshift64*, deliberately not `ctx.random()`. The seed lives on `world_config.rngSeed` and is advanced exactly once per tick, then written back |
| What counts as a "significant event" in the log | the `logs.push(...)` calls in `tick` (currently: births, deaths, predator appearances/kills/despawns) — the trim-to-50 logic right after doesn't need touching |
| Counts / recent events (the text info panel) | `app/WorldView.tsx` — subscribes to all five tables (including `person`, for the profile-name feature below), passes `creatures`/`food`/`gridSize`/`ownerInitials` down as props to `WorldCanvas` |
| Profile-name labels above a player's own creatures | `person.owner`/`person.createdAt` + `creature.owner` in `spacetimedb/src/index.ts` (see CLAUDE.md); the reduction to "latest name per identity, as initials" is `app/WorldView.tsx`'s `ownerInitials` `useMemo`; the actual label draw is the `entry.ownerKey`/`ownerInitialsRef` block right after the glyph `fillText` in `app/WorldCanvas.tsx`'s `draw()` |
| The People/guestbook SSR path (`app/page.tsx`'s initial render) | `lib/spacetimedb-server.ts`'s `fetchPeople()` — deliberately returns only `{ name }`, not the full `Person` row; see the `PersonData` comment for why (Identity/Timestamp are class instances that break Next's server→client prop boundary) |
| The world's visual rendering (canvas, camera, pan/zoom, interpolation) | `app/WorldCanvas.tsx` — see its own section below, it's substantial enough to warrant one |
| The LLM prompt / how a description compiles into behavior | `CREATURE_COMPILE_SYSTEM_PROMPT` (what Groq is asked for — placeholders in it must look unmistakably like placeholders, not valid JSON, or the model echoes them literally; also specifies the `glyph` must be a real emoji and requires a `habitat` field) + `clampCreatureParams` (what happens to the behavior/glyph fields it returns) + `clampHabitat` (the separate parser for `habitat` — kept out of `CreatureParams` on purpose, see CLAUDE.md) + `DEFAULT_CREATURE_PARAMS` (the fallback), all in `spacetimedb/src/index.ts` |
| Which LLM / model | `GROK_API_URL` (actually Groq — `api.groq.com`, not xAI), `GROK_MODEL` — verify against https://console.groq.com/docs/models; if it's a reasoning model (most are), also check `LLM_MAX_TOKENS` (currently `800` — see CLAUDE.md for why `500` measurably wasn't enough) and `reasoning_effort` have enough room |
| Where a spawned creature's position comes from | `pickSpawnPosition()` in `spacetimedb/src/index.ts` — reservoir-samples a cell matching the LLM-inferred habitat biome from `terrain.cells` in one pass; falls back to uniform-random if habitat is `"any"` or no matching cell exists |
| The LLM key itself | `spacetime call prompt-wars set_llm_key '"<key>"' --server local` (and again with `--server maincloud` for that environment) — first caller becomes the permanent owner, see CLAUDE.md |
| How a compiled param actually changes behavior | `seeksFood`/`fleesLarger` in the movement block, `aggression` via `AGGRESSION_ENERGY_SCALE` in the energy block — all inside the per-creature loop in `tick` |
| The spawn form / plain-language result text | `app/SpawnCreature.tsx` — `useProcedure(procedures.spawnFromPrompt)`, renders the returned `summary` |
| Per-creature glyph/color, plain-language behavior summary | `describeCreatureParams()` (the summary text — now also appends the inferred habitat, e.g. "spawned near a thermal vent") and the `creature.glyph`/`creature.color` columns (the visual, rendered as the emoji glyph directly on canvas — no circle/color underneath it besides the glow), both in `spacetimedb/src/index.ts` |
| Biome food/burn multipliers | `world_config.{bloom,cold,vent,barren}{Food,Burn}Mult` — retune live with `spacetime call prompt-wars set_biome_multipliers <0-3> <foodMult> <burnMult> --server <env>`, no republish |
| How terrain is generated / patch size / patch count | `generateTerrainCells()` — value noise, not random points: one 2-octave bilinear-upscaled field per biome (`randomGrid`/`sampleGrid`), argmax per cell wins. `TERRAIN_COARSE_CELLS`/`TERRAIN_FINE_CELLS` control patch scale (smaller number = bigger patches — each is a fraction of the grid, not an absolute cell count) and `*_WEIGHT` controls how much the finer octave roughens the dominant shape. Called from `init`, `setGridSize`, and standalone via `regenerateTerrain` |
| How the food-spawn/energy-burn multipliers actually affect the tick | `multiplierForBiome()` + `biomeAt()` (pure lookups) and their two call sites in `tick`: the per-creature burn calculation, and the food-spawn probability check |
| The terrain's visual palette (biome colors, food color, void color) | `BIOME_BASE_RGB`, `FOOD_COLOR`, `VOID_COLOR` in `app/WorldCanvas.tsx` — the *only* three things to touch to restyle the theme. No per-cell jitter/texture noise on top — an earlier version had that and it read as grainy static, not soft fields; don't re-add it |
| Predator ecology: spawn trigger, hunt range, energy/kill limits | `PREDATOR_SPAWN_POP_FOOD_RATIO`/`PREDATOR_MIN_POPULATION_TO_SPAWN`/`PREDATOR_MAX_ACTIVE` (when one appears), `PREDATOR_HUNT_RADIUS` (how far it senses prey — a fixed cell count, tuned for the current 300-cell grid; scale it if `GRID_SIZE` changes a lot, or predators stop finding anything), `PREDATOR_ENERGY_BURN_PER_TICK`/`PREDATOR_ENERGY_FROM_KILL`/`PREDATOR_MAX_KILLS` (the two independent despawn bounds — starvation and kill-count) — all in `spacetimedb/src/index.ts`, the predator branch (`if (current.isPredator)`) at the top of `tick`'s per-creature loop, and the spawn check right after the food-spawn loop |
| Predator visuals (the sharp red/white diamond) | `PREDATOR_FILL`/`PREDATOR_STROKE` and the `if (entry.isPredator)` branch in `draw()`, `app/WorldCanvas.tsx` — the only entity that isn't a soft glowing circle, on purpose |
| The static branding images (og:image, hero, wordmark) | `public/og-image.png` / `hero.png` / `wordmark.png` — see "Static assets" below for exact dimensions and how to swap them |
| See a published change live on Maincloud, not just local | `README.md` -> "Watching the Maincloud world in the browser": repoint all four vars in `.env.local` to `wss://maincloud.spacetimedb.com`, `npm run spacetime:publish`, check `spacetime describe` parity local vs. maincloud, restart `npm run dev`. A blank World panel with no error = schema mismatch, not a render bug |

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
food)`), a `fleesLarger` creature does the same over other creatures, and now a
predator does the same again hunting prey — none of these are spatial-indexed. At the
current caps (60 population, 120 food, on an 80×80 grid, at most `PREDATOR_MAX_ACTIVE`
= 2 predators) that's a few thousand comparisons per tick at most, still trivial for a
tick every 2 seconds. If you raise the caps by another order of magnitude, this is the
first thing to revisit (a grid-cell bucket index, or just capping the search radius) —
not before, since it isn't the bottleneck at this scale and a spatial index is real
complexity you don't need yet.

## `app/WorldCanvas.tsx` — the canvas renderer

Takes `gridSize`/`creatures`/`food` as props from `WorldView` (no subscriptions of its
own). Everything it needs to touch:

| I want to change... | Look at |
|---|---|
| Canvas/container size, aspect ratio | the `containerRef` `<div>`'s inline style (`aspectRatio: '1'`, `maxHeight: '75vh'` when not fullscreen; both are dropped in favor of `height: '100%'` while `isFullscreen` is true) — actual pixel sizing itself happens in the `ResizeObserver` callback, don't touch that math. It already reads the container's real (possibly non-square) `getBoundingClientRect()` for both dimensions, so fullscreen's different aspect ratio needed no changes there |
| Fullscreen toggle | the button in the returned JSX + `toggleFullscreen()` (native `Element.requestFullscreen()`/`document.exitFullscreen()`) + the `isFullscreen` state, kept in sync via the `fullscreenchange` event listener rather than assumed from the click (the user can also exit via Esc, which only fires that event) |
| Camera pan/zoom feel from keyboard | `PAN_SPEED`, `ZOOM_SPEED` |
| Zoom limits | `MIN_ZOOM_ABS` (absolute floor) and `MAX_ZOOM`; the *effective* min is recomputed on every layout change as a fraction of fit-zoom, in `fitCamera` |
| How much of the world you see by default (on load / pressing `0`) | `INITIAL_VIEW_FRACTION` in `app/WorldCanvas.tsx` (currently 0.18 = 18% of the grid) — this is deliberately *not* the same thing as the whole-world zoom-out floor below |
| How much margin the whole-world zoom-out floor leaves | `FIT_MARGIN` (a fraction below exact edge-to-edge, e.g. `0.94` = ~6% margin), used for `minZoomRef` inside `fitCamera` |
| Whether the camera re-fits or just clamps on resize/orientation change | `userAdjustedRef` — re-fits on every layout change until the user actually pans/pinches/keyboard-pans, then only clamps. Don't turn this back into a one-shot latch: that was the actual cause of "the grid doesn't fill the canvas" (a fit computed before the container's CSS `aspect-ratio` had settled, then locked in forever) |
| How far you can pan past the world's edge | the `margin` calculation in `clampCamera` |
| Creature glyph size / glow | the per-creature draw block inside `draw()` — `radius` (drives both the glow gradient and the emoji `ctx.font` size, so size growth reads as a visibly bigger glyph, not just a bigger invisible hitbox), the `createRadialGradient` call, the `fillText(entry.glyph, ...)` call. Predators are the one exception — still the sharp `PREDATOR_FILL`/`PREDATOR_STROKE` diamond, never a glyph |
| Food dot appearance | the food loop in `draw()`, just above the creature loop |
| The terrain texture (soft biome fields, blurred boundaries) | `buildTerrainTexture()` — builds a tiny `gridSize x gridSize` offscreen canvas, one flat colour per cell (`BIOME_BASE_RGB`, no per-pixel jitter); `draw()` then `drawImage()`s it hugely upscaled, and the browser's own bilinear smoothing turns the hard per-pixel edges into the soft blurred look. No blur filter, no image asset |
| Position interpolation (the tick-to-tick lerp) | the `useEffect` watching `creatures` (builds `interpRef`) + the `t = ...` line inside `draw()`, which reads `tickIntervalMsRef.current` — a ref mirror of the `tickIntervalMs` prop passed down from `app/WorldView.tsx` (`world_config.tickIntervalMicros / 1000`), not a hardcoded constant. This is what keeps interpolation accurate after a live `set_tick_speed` call — don't reintroduce a fixed `TICK_INTERVAL_MS` constant here |
| Pan/pinch behavior | `onPointerDown`/`onPointerMove`/`endPointer` — pan is the 1-pointer branch, pinch-to-zoom-around-midpoint is the 2-pointer branch |
| Keyboard bindings | the key-name arrays in the `keydown` handler and the `loop()` function's key-to-`dx/dy/zoomMul` mapping |

Three things it deliberately does *not* do, so a future change doesn't accidentally
reintroduce them: no game engine/scene graph (`draw()` is one flat function issuing
Canvas 2D calls), no animation easing beyond the position lerp (zoom/pan themselves are
never eased, only creature movement is), and no per-frame React re-render for drawing
(the `requestAnimationFrame` loop reads everything through refs — `cameraRef`,
`foodRef`, `gridSizeRef`, `interpRef`, `tickIntervalMsRef` — so `draw()` never needs recreating and drawing
is fully decoupled from React's render cycle; only pan/zoom/keyboard *inputs* go through
`setCamera`, which is intentionally kept as real React state per the actual requirement).

## Static assets (`public/`) and branding

Three placeholder PNGs, hand-encoded (no image tool was available when these were
created — see the exact dimensions below if you regenerate them with something better):

| File | Dimensions | Used by | Notes |
|---|---|---|---|
| `public/og-image.png` | **1200×630** | `app/layout.tsx` → `metadata.openGraph.images` / `metadata.twitter.images` | The standard Open Graph/Twitter card size — don't deviate, crawlers crop to this aspect ratio |
| `public/hero.png` | **1600×900** (16:9) | `app/FirstLoadOverlay.tsx`, as a `background-image` with `background-size: cover` | Covers any viewport including mobile portrait via `cover`; doesn't need to be portrait itself |
| `public/wordmark.png` | **800×200** (4:1), transparent background | `app/FirstLoadOverlay.tsx`, as an `<img>` | Currently a geometric placeholder (glowing dots, no rendered text) — no font rasterizer was available to draw an actual logotype by hand; swap for real artwork whenever you have it, same filename, no code changes needed |

`NEXT_PUBLIC_SITE_URL` (in `.env.local`, alongside the `SPACETIMEDB_*` vars) must be the
real deployed origin before you post a launch link anywhere — `metadata.metadataBase` in
`app/layout.tsx` uses it to resolve `og:image` to an absolute URL, and it currently
defaults to `http://localhost:3001`.

`app/FirstLoadOverlay.tsx` shows once per browser (a `localStorage` flag), dismisses on
tap anywhere, and is the only thing in this project using `<img>` instead of drawing —
intentional, since it's outside the game world entirely and next/image's optimization
pipeline is unneeded overhead for two static files.
