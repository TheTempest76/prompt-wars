# prompt-wars

A shared 2D world where a scheduled reducer ticks creatures forever, whether or not
anyone is watching. See `ARCHITECTURE.md` for "where do I change what" once the game
logic exists (Checkpoint 3+). This file is the mental model and the command reference.

## The mental model (read this if databases are new to you)

There is no API server in this project. That's not a simplification for the demo —
SpacetimeDB **is** the server. Your application logic runs *inside* the database, so
"backend" and "database" are the same process.

- **Table** — a SQL table. Rows are typed structs you define in TypeScript.
- **Reducer** — the only way to write to a table. A reducer is a plain function that
  runs *atomically*: it either fully applies or fully rolls back, and it cannot do
  anything non-deterministic (no `Date.now()`, no `Math.random()`, no outbound network).
  It cannot return data to whoever called it — see subscriptions below.
- **Procedure** — like a reducer, but allowed to make outbound HTTP calls (`ctx.http.fetch`)
  and *can* return a value directly to the caller. Use it for exactly one thing in this
  project: the one-shot Grok call at creature spawn (`spawnFromPrompt`).
- **Subscription** — how a client reads anything. The client registers a SQL-ish query
  ("give me all rows in `person`"); SpacetimeDB sends the matching rows immediately, then
  pushes every future insert/update/delete for that query over the same WebSocket, live.
  This is why the UI never polls and never needs a "refresh" button — `useTable` gets
  called again by React whenever a row it's watching changes.

So the flow for anything the user does is: client calls a reducer → reducer commits a
row change → every subscribed client (including the one that called it) gets the update
pushed to it → React re-renders. There is no route handler, no REST endpoint, no "fetch
after mutate" — the mutation *is* the fetch trigger.

## Cold-start commands

Two long-running processes, then the usual `npm run dev`.

```bash
# Terminal 1 — the local SpacetimeDB server. Leave this running.
spacetime start

# Terminal 2 — one-time per machine, or after deleting node_modules
npm install

# Terminal 2 — publish the module (re-run this any time spacetimedb/src changes)
npm run spacetime:publish:local

# Terminal 2 — regenerate client bindings (re-run any time spacetimedb/src changes —
# see "When you MUST re-run generate" below)
npm run spacetime:generate

# Terminal 2 — the Next.js app
npm run dev
```

Then open **http://localhost:3001** (not 3000 — see gotcha below).

## Changing a value in `spacetimedb/src/index.ts` — the full checklist

Whether you tweaked a tuning constant (`SIZE_GROWTH_PER_MEAL`, `PREDATOR_MAX_ACTIVE`,
`LLM_MAX_TOKENS`, ...), added a reducer, or changed a table — same steps, every time,
in this order. Skipping a step is the #1 cause of "I changed the code but nothing
happened" or "it works locally but not on the live site."

```bash
# 1. Build + typecheck the module first — catches mistakes before they touch a
#    real database, local or Maincloud.
spacetime build --module-path spacetimedb

# 2. Publish to LOCAL first. Try your change here before Maincloud.
spacetime publish prompt-wars --server local --yes
# Read the "Database Migration Plan" it prints:
#   - No output / only new tables/columns with defaults -> safe, non-destructive.
#   - "Reordering table X requires a manual migration" -> you inserted a new column
#     in the middle of a table instead of appending it at the end. Move it to the
#     end of that table's field list and republish (see the column-ordering gotcha
#     below) — do NOT reach for --delete-data to work around this.
#   - "All clients will be disconnected due to breaking schema changes" -> expected
#     for any new/changed column; not destructive by itself, just a reconnect blip.

# 3. Regenerate client bindings from the now-published schema. The client
#    (app/*.tsx) only ever sees types/fields that exist in src/module_bindings/ —
#    skip this and new columns/reducers are invisible to the UI even though the
#    database already has them.
npm run spacetime:generate

# 4. Typecheck AND build the Next.js app, not just tsc. `next build` catches things
#    plain tsc doesn't (e.g. new columns of type Identity/Timestamp can't cross a
#    Server->Client component prop boundary — this has actually happened, see
#    CLAUDE.md's profile-name decision).
npx tsc --noEmit
npm run build

# 5. Exercise the change directly, before touching the browser (see "Validating
#    the SpacetimeDB half" in CLAUDE.md) — e.g.:
spacetime call prompt-wars <your_reducer> <args> --server local
spacetime sql prompt-wars --server local "SELECT * FROM <your_table>"

# 6. Once it looks right on local, repeat the publish + generate on Maincloud too
#    (generate again is required even though the schema is now identical to local's
#    — it's a separate `spacetime generate` invocation, not shared state):
spacetime publish prompt-wars --server maincloud --yes
npm run spacetime:generate
```

**For the running UI to pick up the change:**
- If your dev server (`npm run dev`) is pointed at **local** (the default —
  `.env.local` has `ws://localhost:3000`): nothing else to do. It already holds a
  live WebSocket subscription, so a republished reducer/schema and any new data show
  up immediately, no refresh needed for data changes — but if `src/module_bindings/`
  changed shape (step 3), **restart `npm run dev`** so Next.js picks up the new
  generated types; a hot-reloaded page can otherwise hold stale bindings.
- If it's pointed at **Maincloud** (`.env.local` has `wss://maincloud...`, per
  "Watching the Maincloud world in the browser" below): same rule, restart
  `npm run dev` after step 6's `spacetime:generate`.
- If you're checking the **deployed Vercel site**, not local `npm run dev`: that site
  always points at Maincloud already (see "Deploying the frontend to Vercel" below) —
  once step 6 is done, the live site picks up new *data* immediately (same
  WebSocket-subscription mechanism), but a new table/column/reducer *shape* needs a
  new Vercel deployment (`git push` / redeploy) so its bundled `src/module_bindings/`
  matches, the same reason local needs a dev-server restart.

### Publishing to Maincloud (the persistent, always-on deployment)

```bash
npm run spacetime:publish        # publishes spacetimedb/ to Maincloud as "prompt-wars"
```

`spacetime.json` sets `"server": "maincloud"`, so a bare `spacetime <cmd> prompt-wars`
already targets Maincloud — `--server maincloud` on the commands below is just being
explicit. `--server local` is the one you must always spell out. Any `--server maincloud`
command needs you logged in first (`spacetime login`).

### Watching the Maincloud world in the browser (see a published change live)

Maincloud's tick runs forever with nobody connected, so it's the deployment to watch if
you want to see the world actually evolve. To point the site at it and see the results
rendered on screen:

1. **Point both halves of the client at Maincloud** in `.env.local`. The browser bundle
   and the server component read *separate* vars — set all four:
   ```
   SPACETIMEDB_HOST=wss://maincloud.spacetimedb.com
   SPACETIMEDB_DB_NAME=prompt-wars
   NEXT_PUBLIC_SPACETIMEDB_HOST=wss://maincloud.spacetimedb.com
   NEXT_PUBLIC_SPACETIMEDB_DB_NAME=prompt-wars
   ```
   `wss://`, not `ws://` — Maincloud is TLS-only. `.env.local` is read once at Next
   startup, so **restart `npm run dev`** after editing it or the browser stays pointed
   wherever it already was.

2. **Publish your change and make Maincloud's schema match the client bindings.**
   `src/module_bindings/` is generated from `spacetimedb/` source; if Maincloud's
   *published* schema is behind that source, the `world_config`/`creature`/`food`/
   `terrain` subscription decodes to nothing and the World panel **renders blank with no
   error** (this has happened — see the schema-mismatch gotcha below). Publish, then
   confirm parity:
   ```bash
   npm run spacetime:publish                                  # push spacetimedb/ to Maincloud
   npm run spacetime:generate                                 # regenerate bindings from source
   spacetime describe prompt-wars --server maincloud --json   # the live Maincloud schema
   spacetime describe prompt-wars --server local    --json    # should describe the same tables/columns
   ```

3. **Start the site and open it** — you do *not* need `spacetime start` running for
   this; that's the local server, and nothing talks to it once `.env.local` points at
   Maincloud.
   ```bash
   npm run dev        # http://localhost:3002   (or `npm run start` -> :3001 — use the port it prints)
   ```

4. **What you should see mapped out** (all rendered by `app/WorldView.tsx` ->
   `app/WorldCanvas.tsx`, all live over one WebSocket — no refresh button anywhere):
   - the **canvas world** — dark void, four soft-edged biome colour fields; drag / pinch,
     or arrows / WASD / `+` / `-` / `0`, to pan and zoom. It opens at ~18% of the world;
     press `0` or zoom out for the whole 300×300 grid.
   - **creatures** as soft glowing coloured circles, each with its LLM-compiled
     `glyph`/`color`, interpolated smoothly between the ~2-second ticks.
   - **predators** as sharp red/white diamonds (no legend — they're meant to just read
     as a threat).
   - **food** as small dots.
   - the **counts + recent-events panel** — population, food count, tick count, and the
     last ~50 birth / death / predator log lines.
   - the **spawn form** — type a description; it round-trips through Groq on Maincloud
     and drops a creature into the same world every other viewer is watching.

5. **Confirm it's live even with every tab closed** (headless, no browser needed):
   ```bash
   spacetime logs prompt-wars --server maincloud -f                                       # tail the tick
   spacetime sql  prompt-wars --server maincloud "SELECT tick_count FROM world_config"    # re-run in 10s: it advanced
   spacetime sql  prompt-wars --server maincloud "SELECT COUNT(*) AS n FROM creature"
   spacetime sql  prompt-wars --server maincloud "SELECT * FROM event_log"                # recent births/deaths/predators
   ```
   Close every tab, wait, re-run the `tick_count` query — it keeps climbing. That's the
   "runs forever whether or not anyone's watching" claim, and Maincloud is where it's
   actually true (local only ticks while `spacetime start` is up).

**Switching back to local:** copy `.env.local.example` over `.env.local` (`ws://localhost:3000`,
all four vars), restart `npm run dev`, and make sure `spacetime start` and
`npm run spacetime:publish:local` have both been run.

### Other useful commands

```bash
spacetime logs prompt-wars --server local -f        # tail module logs (console.log from reducers)
spacetime sql prompt-wars --server local "SELECT * FROM person"   # ad-hoc query
spacetime publish --module-path spacetimedb --server local --delete-data=always --yes prompt-wars
                                                     # wipe + republish (schema conflict escape hatch)
```

## Deploying the frontend to Vercel

The Next.js app is a normal zero-config Vercel deploy — no `vercel.json` needed, Vercel
auto-detects the framework from `next build`. What actually needs doing:

1. **Import the GitHub repo** (`TheTempest76/prompt-wars`) into Vercel — dashboard →
   Add New → Project → pick the repo. Leave Build/Install/Output commands on their
   Next.js defaults.
2. **Set the environment variables** (Project Settings → Environment Variables), applied
   to **Production, Preview, and Development** — this is a single shared world, so every
   deployment (including previews) should point at the same Maincloud database, never at
   `localhost`:
   ```
   SPACETIMEDB_HOST=wss://maincloud.spacetimedb.com
   SPACETIMEDB_DB_NAME=prompt-wars
   NEXT_PUBLIC_SPACETIMEDB_HOST=wss://maincloud.spacetimedb.com
   NEXT_PUBLIC_SPACETIMEDB_DB_NAME=prompt-wars
   ```
   `NEXT_PUBLIC_SITE_URL` is optional on Vercel — `app/layout.tsx` falls back to the
   platform's own `VERCEL_URL` when it's unset, so preview deployments still get correct
   `og:image` URLs. Set it explicitly only once you've attached a custom production
   domain (otherwise OG images on the production alias would resolve to the
   `*.vercel.app` URL instead).
3. **Deploy.** The root page (`/`) prerenders statically at build time (it has no
   per-request dynamic API usage), so the one-time server-side `fetchPeople()` call runs
   during `next build`, not per request — a slow or failed Maincloud round-trip at build
   time just falls back to an empty list (see the `try`/`catch` in `app/page.tsx`), it
   doesn't fail the build. Everything that actually matters for gameplay (`world_config`/
   `creature`/`food`/`terrain`/`event_log`) is subscribed to live, client-side, over the
   SpacetimeDB WebSocket — same as local dev, just pointed at Maincloud.
4. **The Groq key is independent of this Vercel setup.** It lives in Maincloud's private
   `llm_secret` table, set once via `spacetime call prompt-wars set_llm_key '"gsk_..."'
   --server maincloud` (snake_case reducer name on the CLI — see the gotchas section)
   — never put it in Vercel's environment variables, the module reads it from the
   database, not from `process.env`.
5. **Custom domain:** once attached, update `NEXT_PUBLIC_SITE_URL` to it and redeploy
   (env var changes require a redeploy to take effect — Vercel doesn't hot-reload them).

## When you MUST re-run `spacetime generate`

Any time you add, remove, or rename a **table, column, reducer, procedure, or their
argument types** in `spacetimedb/src/index.ts`, the TypeScript types in
`src/module_bindings/` are now lying to you. `tsc` will not catch this on its own if
the shape still happens to compile — you'll get a runtime error from the WebSocket
protocol instead, which looks nothing like a type error. Publish first, generate second:

```bash
npm run spacetime:publish:local && npm run spacetime:generate
```

`src/module_bindings/` is 100% generated. Never hand-edit it — the top of every file
says so, and your edits are gone on the next `generate`.

## Gotchas hit so far

- **Port 3000 is double-booked.** `spacetime start` listens on `3000`. Next's default
  dev port is *also* `3000`. Nothing errors loudly — both processes will happily bind,
  and whichever wins ends up eating the other's HTTP requests (you'll see a page render,
  but the server-side SpacetimeDB fetch in `lib/spacetimedb-server.ts` times out after
  10s because its request went to Next, not SpacetimeDB). Fixed by pinning Next to 3001
  in `package.json`'s `dev`/`start` scripts (`next dev -p 3001`). If you ever see that
  10-second timeout again, check `netstat -ano | grep 3000` for two LISTENING PIDs before
  you suspect anything else.
- **`table({ scheduled: ... })` is deprecated in SDK 2.10.0** — use
  `spacetimedb.reducer({ onSchedule: someTable }, ...)` instead (what `tick` in
  `spacetimedb/src/index.ts` actually uses). The schema and the reducer can live in
  separate files this way, which matters once `index.ts` gets split up.
- **`init` only runs on a database's *very first* `publish`, ever.** Adding a new
  scheduled table (or any other row `init` is supposed to seed) to an *already-existing*
  database does nothing on a normal republish — `init` doesn't re-fire just because the
  schema changed. Symptom: your new table exists but stays empty, and a scheduled reducer
  never fires because nothing ever inserted a row into its schedule table. Fix: republish
  with `--delete-data=always` (wipes and re-runs `init`), or seed the row by hand with
  `spacetime call`.
- **`ctx.random` is seeded from `ctx.timestamp`, not from anything in your tables.**
  It's reproducible on replay (SpacetimeDB records the call's timestamp), but you can't
  explain a creature's behavior just by reading table state. We store an explicit
  `rngSeed` column in `world_config` instead and advance it ourselves — see Checkpoint 3.
- **Procedures are synchronous.** `ctx.http.fetch()` blocks and returns a value directly
  — no `await`, no promise, and you can't hold a transaction open while it runs. Set an
  explicit short `timeout` on the fetch or a slow LLM call wedges the calling connection.
- **No env vars inside modules.** `spacetimedb/` has no `process.env`. There's no built-in
  secrets story for the Grok key — see Checkpoint 4 for how we handle it (a private
  table + a write-once-per-owner reducer to set it, never sent to the client).
- **Anonymous identity lives in the browser's `localStorage`.** Two tabs in the *same*
  browser share one identity/token. To test as two separate "players," use a normal
  window + a private/incognito window, not two tabs.
- **`spacetime call`/`spacetime sql` use the reducer/table's snake_case wire name, not
  the camelCase TypeScript export name.** `export const setPopulationCap = ...` in
  `spacetimedb/src/index.ts` is `set_population_cap` on the CLI
  (`spacetime call prompt-wars set_population_cap 100 --server local`). Get this wrong
  and the error is at least helpful (`A reducer with a similar name exists: ...`), but
  it'll cost you a beat every time if you don't know to expect it. Client-side
  (`reducers.setPopulationCap(...)` via `useReducer`) uses the camelCase name as normal
  — this only bites you on the raw CLI.
- **`spacetime generate` won't delete stale binding files without an interactive
  confirmation**, and our npm script runs non-interactively. Rename or remove a table
  and the old `..._table.ts` sticks around in `src/module_bindings/` (harmless — nothing
  imports it — but confusing clutter). Delete it by hand when `generate` warns
  `"The following files were not generated by this command and will be deleted"` and
  you don't see a follow-up prompt actually take effect.
- **`spacetime call` against a *procedure* (not a reducer) logs a scary but harmless
  `ERROR: ... External attempt to call nonexistent reducer "..."` line in `spacetime
  logs`, then succeeds anyway.** The CLI appears to try the reducer-call path first,
  which the server logs as a failed attempt, then falls back to the correct
  procedure-call path, which works. If your `spacetime call` printed the expected
  return value, ignore that specific log line — it's not describing what actually
  happened to your call. If you got no return value printed at all, that's a real
  failure and worth investigating.
- **A `gsk_...` key is Groq, not xAI's "Grok."** Nearly-identical names, completely
  different services/endpoints/models. We built this against `api.x.ai` first, got a
  Groq key, and had to swap the base URL to `api.groq.com/openai/v1/...` — check which
  one you actually have before assuming.
- **Verify `GROK_MODEL` against https://console.groq.com/docs/models before relying on
  it** — availability changes often, and an unknown model id is a 404 that the
  fallback swallows silently (indistinguishable from a bad key or a timeout — that's
  the whole point of the try/catch). `curl` the same request directly, outside the
  module, when a spawn's output looks suspiciously like `DEFAULT_CREATURE_PARAMS`
  rather than something the model actually reasoned about.
- **Every general-purpose Groq model available on a fresh key is a *reasoning* model**
  (`gpt-oss-20b`/`120b`, `qwen3.x` at the time of writing) — it spends tokens on an
  internal `reasoning` field before emitting `content`. A `max_tokens` sized for just
  the JSON answer (we started at 300) gets exhausted mid-reasoning, `content` comes back
  empty, and `JSON.parse('')` throws — silently triggering the fallback with no visible
  error anywhere. Fixed with a bigger `max_tokens` (originally 500, later 800 — see
  below) and `reasoning_effort: 'low'` in the request body. If a Groq-backed spawn
  keeps landing on defaults, check `finish_reason` in the raw response before
  suspecting anything else. **Update:** 500 wasn't actually enough headroom — seeding
  30 creatures in one batch showed ~13% landing on the default `🦠` glyph specifically
  (not the whole fallback — just the `glyph`/`habitat` fields added later, which sit at
  the *end* of the requested JSON and are the first casualty of a truncated response).
  Bumped to 800 and re-ran the two prompts that had failed ("a tiny shrimp...", "a
  school of silver minnows...") — both got a real matched emoji (🦐, 🐟) on the retry.
  If defaults reappear in a cluster after this, raise it again rather than assuming a
  prompt-wording problem.
- **An LLM will follow a JSON example key literally if it looks like a valid value.**
  The system prompt originally had `"glyph": "X"` as a placeholder; the model read it as
  "always answer X" and every creature got the same glyph. Placeholders need to look
  unmistakably like placeholders — `<pick one character or emoji that fits, e.g. "🦂">`
  — not something that parses as valid JSON on its own.
- **If one environment's schema falls behind another's, the client silently breaks in
  that environment — not with an error you'll notice, with data that just never
  arrives.** `.env.local` pointed the browser at Maincloud while only `local` had
  Checkpoint 4's new `creature` columns; the client bindings (generated against
  `local`) expected `glyph`/`seeksFood`/etc. on every row, Maincloud's actual rows
  didn't have them, decoding failed, and the entire `world_config`/`creature`
  subscription just never populated — symptom: "the whole World section is stuck on
  placeholders," not a visible error. Whenever something that used to render goes
  blank after a schema change, check `spacetime describe <db> --server <env> --json`
  against *the environment `.env.local` actually points at*, not just the one you
  happened to publish to most recently.
- **Adding `.default(value)` to a newly-appended column lets a schema change reach an
  already-running world via a normal `spacetime publish` — no `--delete-data=always`,
  no lost history.** This is what fixed the Maincloud mismatch above without wiping its
  (by then) 1000+-tick-old population: added `.default(...)` matching
  `DEFAULT_CREATURE_PARAMS` to the six new `creature` columns, republished normally, and
  the migration plan showed `Created columns ... (default: ...)` instead of destroying
  the table. Only works for newly-appended non-key columns (see CLAUDE.md) — reach for
  this before `--delete-data=always` whenever the data is worth keeping.
- **New columns must be *appended*, not inserted earlier in the row — even with
  defaults.** Adding the eight biome multiplier columns to `world_config` between
  `foodCap` and `rngSeed` (matching the source's logical grouping) failed outright:
  `Reordering table world_config requires a manual migration`, publish aborted before
  touching anything. Moving the same columns to the end of the field list (after
  `lastTickAt`) fixed it — same defaults, same values, just appended instead of
  inserted. Column *position* in the table definition matters for migrations
  independent of whether a default is present; always add new fields at the end.
- **A one-shot camera "fit on first load" flag is a trap.** `WorldCanvas.tsx` used to fit
  the camera exactly once, gated by `hasFitRef`. If that first `ResizeObserver` callback
  fires before the container's CSS `aspect-ratio: 1` has settled to its final square box
  — or before `gridSize` has even arrived from the subscription — the fit locks onto a
  wrong/stale measurement *forever*: every later resize (rotating a phone included) only
  clamps the already-wrong zoom instead of recomputing it. Symptom: "the grid doesn't
  fill the canvas," with no error anywhere. Fixed by re-fitting on every layout change
  until the user actually touches the camera (`userAdjustedRef`, set only inside real
  pan/pinch/keyboard handlers) instead of latching after the first attempt.
- **A creature whose LLM-compiled prompt implies passivity (e.g. "wandering") often
  gets `seeksFood: false` from Grok** — a fair, literal interpretation of the prompt, but
  on an 80×80 grid with ~2% of cells holding food, a pure random-walker's odds of
  stumbling onto food before starving (~20 ticks on `CHILD_STARTING_ENERGY`) are poor.
  A batch of "wandering creature" test spawns died out almost entirely within a few
  dozen ticks — not a bug, just this project's actual ecology working as designed. Seed
  test data with prompts that clearly imply active foraging ("hungry, actively hunts for
  food") if you want a population that survives long enough to reproduce.
- **A predator deleting its prey mid-tick could crash the entire tick reducer, on every
  subsequent tick, forever, until republished.** The per-creature loop iterates a
  start-of-tick snapshot; if a predator (processed earlier in that same iteration) ate a
  creature that appears *later* in the snapshot, that creature's own turn still ran its
  full logic and tried to `update()` a row that predator had already deleted —
  `PANIC: ... The row was not found, e.g., in an update call`, repeating every tick
  (`spacetime logs` filled with it) because the schedule keeps firing the same broken
  reducer. **This is the single most important gotcha in this file if you're adding
  anything that can delete another row mid-tick**: any per-entity loop over a
  start-of-tick snapshot needs an existence check (`if (!ctx.db.X.id.find(current.id))
  continue;`) at the top of each iteration, not just at the point where you're about to
  delete something. Caught by noticing `tick_count`/entity `energy` values had frozen
  solid across multiple checks spaced minutes apart, then confirmed via `spacetime logs`
  (the panic trace names the exact source line). Fixed and republished to both
  environments immediately on discovery — see git history for exact timing if you need
  to know how long either environment was down.
- **Growing `GRID_SIZE` without also growing food density can starve the entire
  population to zero.** `foodCap`/`foodSpawnPerTick` are absolute counts, not a density
  — when the grid grew 80→300 (14x the area) with `foodCap` left at 120, the average
  distance to the nearest food went up by roughly the same factor, and creatures were
  dying of starvation faster than they could travel to it. Watched it happen directly:
  population went from a healthy 33 to 1 within a few minutes of the grid change, no
  crash involved this time, just genuine starvation at the new scale. Any future
  `set_grid_size` to something much bigger than the current 300 should come with a
  proportional `set_food_config` bump, or budget for a real repopulation die-off first.

## Checkpoint 1 status

Done: `person` table + `add`/`sayHello` reducers (stock template, unmodified), Next.js
App Router wired via `SpacetimeDBProvider` (`app/providers.tsx`), live subscription via
`useTable` (`app/PersonList.tsx`), server-rendered initial data via a throwaway
subscribe-then-disconnect connection (`lib/spacetimedb-server.ts`).

Verified: called the `add` reducer from one connection, watched a second, independent
connection receive the insert via its live subscription with no poll and no refresh —
the same `useTable`/`onInsert` mechanism the browser UI uses. (Browser automation wasn't
available in this session to literally screenshot two tabs; the two-connection check
exercises the identical code path the UI depends on. Worth a 30-second manual sanity
check yourself: open http://localhost:3001 in two windows, add a name in one, watch it
appear in the other with no refresh.)

## Checkpoint 2 status

Done: `world_tick` (singleton counter row), `tick_schedule` (private, drives the
schedule), and `event_log` (bounded to the last 50 rows, trimmed every tick) in
`spacetimedb/src/index.ts`. The `tick` reducer is bound via
`spacetimedb.reducer({ onSchedule: tick_schedule }, ...)` and fires every 2 seconds
forever. Both public tables render live in `app/WorldTick.tsx`.

*(Superseded in Checkpoint 3 — `world_tick`'s columns moved onto `world_config`, and
`app/WorldTick.tsx` became `app/WorldView.tsx`. Keeping this section as-is since the
verification below is still true of what shipped at the time.)*

Verified with zero client connections open — no browser tabs, no CLI queries, nothing
touching the module — for 65 seconds:

```
before: id=0  count=48   last_tick_at=2026-09-05T13:18:44Z
                       (65s wait, nothing connected)
after:  id=0  count=106  last_tick_at=2026-09-05T13:20:40Z
```

58 ticks over ~116 seconds elapsed, matching the 2-second interval — the reducer kept
firing purely off the schedule table, independent of any client. `event_log` held
steady at exactly 50 rows (`SELECT COUNT(*) AS n FROM event_log`) the whole time,
confirming the trim logic bounds it instead of growing forever.

This was checked against the **local** server, not Maincloud — `spacetime start`
staying up is what kept the tick alive here, not any property of Maincloud specifically.
The real "keeps running when everyone logs off, including you and your laptop" claim
needs Maincloud (`npm run spacetime:publish`) before the actual demo; local only proves
the *reducer logic* doesn't depend on a connected client, which was the part in doubt.

## Checkpoint 3 status

Done: `world_config` (singleton — grid size, population cap, food cap, `rngSeed`, tick
count), `creature`, and `food` in `spacetimedb/src/index.ts`. The `tick` reducer now
runs the actual simulation: each creature finds the nearest food (greedy, no
pathfinding), moves one cell toward it, eats/burns energy, grows or shrinks, dies at
zero energy, and reproduces (mutating `size`) above an energy threshold — gated by
`world_config.populationCap` so growth can't run away. Food tops back up toward its cap
a couple cells a tick. All of it driven by `makeRng()`, a seeded xorshift64* advanced
once per tick and stored back on `world_config.rngSeed` — not `ctx.random()` — so a
tick's outcome is reproducible from that row alone. `event_log` now only records
births/deaths (not a redundant per-tick line, since the tick count is already visible
on `world_config`). Rendered as a plain ASCII grid plus counts and a recent-events list
in `app/WorldView.tsx` (replaces `app/WorldTick.tsx`).

Verified against the local server via CLI, without touching the browser:
- `spacetime sql prompt-wars --server local "SELECT * FROM creature"` after ~14 ticks
  showed population grown from 8 seeded creatures to 12, with varied `size` values
  (0.94–1.24) confirming mutation on reproduction.
- `spacetime sql ... "SELECT * FROM event_log"` showed the actual reproduction events:
  `Creature #6 reproduced -> #9 (size 1.24)`, etc., each tagged with the tick it
  happened on.
- `spacetime call prompt-wars set_population_cap 5 --server local` immediately dropped
  the cap and a follow-up `SELECT population_cap FROM world_config` confirmed it —
  proving the cap is tunable live, no republish. Restored to 60 after.

Population cap is intentionally **not** exposed in the UI yet — no reducer-calling
control was asked for at this checkpoint, and it's one `spacetime call` away when
needed. `app/WorldView.tsx` is read-only.

*(Superseded in part by Checkpoint 4 — grid shrunk to 20×20, population cap to 20, food
cap to 25, per a later request; see `spacetimedb/src/index.ts` for current values.)*

## Checkpoint 4 status

Done: `creature` gained `glyph`, `color`, `seeksFood`, `fleesLarger`, `aggression`, and
`prompt` columns; a private `llm_secret` table (`id`, `owner`, `apiKey`); `setLlmKey`
(write-once-per-owner — the first identity to call it owns it, checked via
`ctx.sender.equals`); and `spawnFromPrompt`, a **procedure** returning `{ creatureId:
u64?, summary: string }` directly to its caller. All in `spacetimedb/src/index.ts`.

**LLM provider is Groq (api.groq.com — the fast-inference API), not Claude/OpenAI/xAI**
— a deliberate choice for this project, made explicit here since it overrides the
"default to Claude" instinct. Easy to mix up with xAI's unrelated "Grok" model; a
`gsk_...` key prefix is the tell that it's Groq. `GROK_API_URL`/`GROK_MODEL` name the
OpenAI-compatible chat completions endpoint (kept the `GROK_` prefix on the constants
since that's what you'll call it out loud — just know it points at Groq's API).
`CREATURE_COMPILE_SYSTEM_PROMPT` asks for pure JSON matching `CreatureParams` (exactly
5 fields, intentionally small); `clampCreatureParams` validates and clamps every field
independently with its own fallback to `DEFAULT_CREATURE_PARAMS` — a response missing
`aggression` but with a valid `glyph` keeps the valid `glyph` and defaults only
`aggression`, it doesn't discard the whole response. The call happens once, entirely
inside `spawnFromPrompt`; the `tick` reducer makes zero network calls, same as always
(reducers can't).

**Getting a real response out of Groq took two fixes past the first working version**
(both now baked into the code, documented here so the debugging isn't repeated):
1. Every general-purpose model on a fresh Groq key (`gpt-oss-20b`/`120b`, `qwen3.x`) is
   a **reasoning model** — it spends tokens on an internal `reasoning` field before
   `content`. At the original `max_tokens: 300`, it hit the cap mid-reasoning and
   `content` came back empty, which `JSON.parse` failed on, which silently triggered the
   fallback — indistinguishable from an auth failure without looking at the raw response
   directly. Fixed with `max_tokens: 500` (`LLM_MAX_TOKENS`) and `reasoning_effort:
   'low'` in the request body to keep the reasoning terse.
2. The system prompt's example shape had `"glyph": "X"` as a placeholder; the model took
   it literally and always returned the string `"X"`. Rewritten as `<pick one character
   or emoji that visually fits it, e.g. "🦂" or "F">` — an obvious placeholder, not a
   valid JSON value — and it started actually choosing (confirmed: a turtle prompt got
   `🐢` and `#4CAF50`).

The three compiled fields have a real, if simple, effect on behavior, not just display:
- `seeksFood: false` → the creature ignores food entirely and only random-walks (still
  eats incidentally if it wanders onto a food cell — this only changes targeting, not
  digestion).
- `fleesLarger: true` → each tick, scans other creatures within `FLEE_RADIUS`; if one is
  more than `FLEE_SIZE_MARGIN`× its own size, it moves directly away instead of toward
  food this tick. No combat, no damage — pure movement-priority override, same
  complexity level as the existing food-seeking heuristic.
- `aggression` (0–10) scales both energy burn *and* energy gained per meal by the same
  factor (`1 + aggression × AGGRESSION_ENERGY_SCALE`) — a real risk/reward trade, not a
  free stat.

Reproduction carries all of these unchanged from parent to child (only `size` mutates,
same as Checkpoint 3) — a deliberate scope decision, not an oversight; see the comment
at the reproduction block in `spacetimedb/src/index.ts`.

Client: `app/SpawnCreature.tsx` (text input, `useProcedure(procedures.spawnFromPrompt)`,
displays the returned `summary` in plain language) and `app/WorldView.tsx`'s ASCII grid
now renders each creature's actual `glyph`/`color` instead of a generic `C`.

**Verified, without a browser:**
- `spacetime call prompt-wars spawn_from_prompt '"..."' --server local` with **no**
  `llm_secret` row at all → returned `{creatureId: 12, summary: "seeks food, aggression
  5/10."}`, matching `DEFAULT_CREATURE_PARAMS` exactly; confirmed via SQL the row was
  created with those defaults.
- Set an intentionally invalid key via `set_llm_key`, called `spawn_from_prompt` again →
  same graceful fallback to defaults, this time after a *real* rejected HTTP round-trip
  (a since-fixed wrong model id, 404) — confirms the `try/catch` and `res.status !== 200`
  check both work against a live non-200 response, not just a thrown exception.
- Dropped `population_cap` to 1 and spawned again → returned `{creatureId: undefined,
  summary: "The world is full right now..."}` instead of crashing or silently dropping
  the request; restored the cap after.
- A throwaway script using the exact generated client bindings
  (`DbConnection`/`procedures.spawnFromPrompt`, the same call `useProcedure` makes) —
  not just the raw `spacetime call` CLI path — confirmed the procedure's return value
  and that the new row arrived over the live subscription with the correct fields, i.e.
  the identical code path the browser UI depends on.
- **With a real Groq key set**, three prompts round-tripped through the actual model and
  produced genuinely distinct, sensible output (not the fallback defaults — confirmed by
  each result differing from `DEFAULT_CREATURE_PARAMS`): *"extremely aggressive
  scorpion"* → `aggression 10, fleesLarger true`; *"gentle giant turtle that never
  flees"* → `aggression 6, glyph 🐢, color #4CAF50`; *"skittish mouse that flees from
  everything"* → `aggression 0, fleesLarger true`. This is the strongest evidence the
  whole path works, not just its failure/fallback branch.

**Update: published to Maincloud too**, non-destructively — see the gotcha below on
using `.default()` to avoid a wipe. Verified there the same way as local: a real Groq
key set, a live spawn (*"graceful arctic fox, flees anything bigger"* → `🦊`, a teal
color, `aggression 3`, `fleesLarger true`), and a scripted client subscribe confirming
`world_config`/`creature`/`food` all decode cleanly.

Still not done: a literal browser click-through (no browser automation available this
session — the scripted client-binding checks above exercise the same code path the
browser UI does).

## Canvas world renderer status

Replaced the ASCII `<pre>` grid with a real `<canvas>` + camera in `app/WorldCanvas.tsx`
(`app/WorldView.tsx` now just fetches and passes props down). Grid grew to 80×80 on both
environments — live, via a new `set_grid_size` reducer, no wipe. See
`ARCHITECTURE.md`'s `app/WorldCanvas.tsx` section for the "what to change where" map.

**What's actually verified, and how:**
- `tsc --noEmit` clean, module builds clean, both after the schema-level `set_grid_size`
  addition and after regenerating bindings.
- Both environments grew to 80×80 via `set_grid_size` with **zero data loss** —
  Maincloud's tick counter didn't reset (it was already past 1900 ticks before this
  change and kept climbing straight through).
- A scripted two-connection check (the "two tabs" proof, run the same way as every prior
  checkpoint): tab A reads `gridSize: 80`; tab B, a fully independent connection, saw
  `world_config`'s `tickCount` advance via its live subscription with no poll, no
  refresh; tab B's `creature`/`food` counts came back intact post-growth. This confirms
  the *data path* into `WorldCanvas`'s props is live and correct.

**What is *not* verified, and why:** everything specific to actually looking at or
touching the canvas — crisp rendering at real device pixel ratios, one-finger pan,
pinch-zoom, `touch-action: none` actually preventing page scroll, the fit-to-view on
first load, keyboard pan/zoom, and whether the on-screen keyboard covers the spawn
input. **No browser or phone was available in this session** (browser automation was
declined earlier and remains off) — everything above the data layer is implemented
against the letter of the spec and reviewed by reading the code back against every
requirement, but genuinely untested by eye or by touch. This is not "verified as
working," it's "verified as wired up correctly as far as I can check without a screen."
**Please test on a real phone before trusting this** — open it over the local network
or the Maincloud URL, not devtools' device emulation, and check: not blurry, one-finger
pan, pinch zoom, the page itself doesn't scroll while panning, and the spawn input is
still reachable/typeable with the keyboard up. Report back what breaks; I have no way to
find that myself right now.

## Biome terrain + visual theme status

Four biomes (nutrient bloom, cold shelf, thermal vent, barren), each with a food-spawn
and an energy-burn multiplier that `tick` actually reads — not decorative. Terrain is
one singleton row (`terrain.cells`, a packed string, one char per cell) generated once
via a cheap Voronoi-style blob scatter, never one row per tile. World grew biomes on
both environments **without a wipe** (see the new column-ordering gotcha above for the
one real snag). Visual theme: dark void outside the world, biome color fields inside it
drawn as one tiny offscreen texture per biome layout and hugely upscaled (the browser's
own bilinear smoothing gives the soft blurred-boundary look, no blur filter, no image
assets), creatures/food the only saturated things on screen.

**Verified, all against the local server via CLI/scripted checks:**
- Cleared all food, waited ~30 ticks, then checked every remaining food row's biome:
  **barren got zero** (multiplier 0 — `rng.next() < 0` is never true), cold shelf got 2
  (low multiplier, 0.4), bloom and vent got 11 and 12 respectively (high multipliers,
  2.0/2.2) — the tick reducer is genuinely reading `world_config`'s biome columns, not
  just storing them.
- `terrain.cells.length === gridSize * gridSize` (6400 at the current 80×80) on both
  environments — confirmed via a scripted subscribe, not just SQL (SQL here doesn't
  support `LENGTH()` as an aggregate).
- Both environments migrated non-destructively (`Created columns ... (default: ...)`,
  not a wipe) after fixing the column-ordering issue; Maincloud's tick counter ran
  straight through past 3000, unaffected.
- A two-connection sync check (same pattern as every prior checkpoint) confirms
  `world_config`/`terrain`/`creature`/`food` all still sync live with no refresh.
- The three static assets are real, valid PNGs (hand-encoded via Node's built-in
  `zlib` — no image tool was available) at their exact required dimensions, confirmed
  by decoding one back and checking specific pixel values (including that the
  wordmark's alpha channel is genuinely 0 at the corners and 255 at opaque centers, not
  just visually appearing transparent in a viewer). All three serve correctly from
  `public/` (`curl` confirmed 200s with the exact byte sizes written), and the rendered
  `<meta property="og:image">`/`twitter:image` tags resolve to correct absolute URLs.

**Not verified, same reason as the canvas renderer above:** what any of this actually
*looks like*. The blob/blur/color-field technique is implemented exactly as designed
and I can reason about why it should look like soft biome fields, but I have not seen
it — no browser this session, same limitation as before. This compounds with the
canvas item above: please look at the actual thing before trusting either description.

## Terrain rewrite, camera fix, ecology rebalance, and predators status

You reported three problems and asked for a fourth feature. Findings, before any of
this was touched (see the conversation for the full writeup): terrain generation was a
24-point Voronoi partition (no frequency control, could cluster by chance) with a
per-*pixel* client-side brightness jitter layered on top — that jitter was the actual
"noisy" culprit. The camera's fit-to-viewport was a one-shot latch that could lock onto
a stale measurement on first load and never self-correct. Food spawn distribution was
already grid-wide uniform; only its rate/cap needed raising.

**Terrain**: rewritten as real value noise — `generateTerrainCells()` now builds one
independently-seeded 2-octave field per biome (`randomGrid`/`sampleGrid`, small 6×6 and
10×10 control grids bilinearly upscaled) and picks the highest-valued biome per cell,
replacing the Voronoi partition. Client-side per-pixel jitter removed entirely. Palette
replaced with your exact hex values (`BIOME_BASE_RGB` in `app/WorldCanvas.tsx`).
Verified via a scripted census: all 4 biomes present in 10 of 16 quadrants of a 4×4
sampling grid (confirms spread, not clustered), cell counts reasonably balanced
(1243–2238 across ~1600-ideal, biggest skew is barren running high), and a
middle-scanline patch-width sample averaging 14.3% of the grid's edge — just under your
15–25% target, close enough that I didn't iterate further on it.

**Camera fit**: replaced the one-shot `hasFitRef` latch with `userAdjustedRef`, which
keeps re-fitting on every layout change (resize, orientation change, `gridSize`
arriving/changing) until the user actually pans/pinches/keyboard-pans the camera —
self-correcting through the exact timing race that caused the original bug. Added
`FIT_MARGIN` (0.94) so the default view has a small margin instead of exact
edge-to-edge. **Not verified visually** (see the canvas-renderer section above — same
no-browser limitation) — I can't confirm by eye that it now fills the viewport on a
real phone in both orientations; the fix addresses the specific race condition I found
by reading the code, but "the code no longer has that race" isn't the same claim as "I
watched it fill the screen." Please check this one specifically.

**Ecology rebalance**: `populationCap` 20→60, `foodCap` 25→120, and a new
`foodSpawnPerTick` (1→5, newly tunable on `world_config` via `setFoodConfig` — it
wasn't tunable before, only `foodCap` was). Verified live: a food-seeking population
grew from a reseeded 18 to the full cap of 60 within a few minutes, with constant
births and deaths churning at cap — visibly "alive," not saturated-and-static. One real
finding while testing, not a bug: creatures spawned from prompts implying passivity
("a wandering creature") got compiled to `seeksFood: false` by Grok and nearly all died
within a few dozen ticks — a pure random-walker's odds of finding food by chance among
~6400 sparse cells are poor. That's the ecology working as designed, not broken; noted
as a gotcha above so it isn't rediscovered as a false alarm.

**Predators**: `isPredator`/`kills` flags on the existing `creature` table (no new
table). Spawn condition lives in `tick`: `population / currentFoodCount >
PREDATOR_SPAWN_POP_FOOD_RATIO`, gated by a population floor and a max-active cap.
**The initial threshold (1.5) needed recalibrating against real numbers, not the
estimate I started with** — with the new generous food cap, a thriving population's
ratio sat around 0.5–0.8 (food climbing toward its own cap pulls the ratio *down* as
the world does well), so 1.5 essentially never fired under normal healthy operation.
Lowered to 0.7 after watching the actual live numbers, which does engage during real
population growth without requiring the world to already be in crisis.

Verified live, watching the actual local world run for about 10 minutes total across
several checks:
- Two predators appeared (`PREDATOR_MAX_ACTIVE` = 2, both slots filled), each logged as
  `"A predator has appeared -- the population outgrew its food supply"`.
- Both hunted down prey within a few ticks of appearing, each kill logged with the
  prey's actual lineage text: `"A predator caught \"a hungry fast creature that
  actively and constant…\""` (truncated at 50 chars, as designed).
- Population held steady at the cap (60) throughout — predation didn't cause a
  collapse; reproduction kept pace. One predator sat at 2 kills / 91 energy (healthy),
  the other at 0 kills / 27 energy (heading toward starvation) — confirms the two
  independent despawn conditions (kill cap, energy) are both live and behave
  differently based on actual hunting luck, not a fixed timer.
- Predator count never exceeded `PREDATOR_MAX_ACTIVE` across the whole observation
  window — no runaway growth.

Not yet directly observed in this session: a predator actually hitting `PREDATOR_MAX_KILLS`
(5) or fully despawning from starvation (energy was trending toward it but hadn't
crossed zero by the last check) — both code paths exist and are exercised by the same
tested mechanism as the rest of the per-creature loop (die-at-zero-energy is identical
logic to normal creatures, already verified extensively in earlier checkpoints), but I
haven't personally watched one specific predator complete its full lifecycle start to
finish. Given the time already spent live-observing this world, I'm reporting this as
"implemented and behaving correctly so far" rather than "the full lifecycle personally
witnessed" — an honest distinction worth preserving rather than rounding up.

Both `local` and `maincloud` migrated non-destructively (new columns appended,
`.default()`-backed) and were reseeded with food-seeking test creatures after the
schema changes disconnected/reset them either environment's population count. Not
verified: what any of this looks like on screen — same standing limitation, no browser
this session.

**Correction to the above, found immediately after writing it:** the predator energy
values I reported as "trending toward zero" between checks had actually *frozen solid*
— both environments were mid-crash-loop the whole time (see the new gotcha above,
"predator deleting prey mid-tick"). Neither predator lifecycle observation above should
be trusted as evidence of healthy long-running behavior; they were snapshots of a tick
reducer that had already stopped advancing. Fixed and republished to both environments;
see the next section for the actually-clean observation.

## World scale, camera default view, and the mid-tick crash fix

Three more changes, requested mid-verification of the above: population capped at 50
(down from 60), the grid grown from 80 to 300, and the camera's default view changed
from fitting the whole world to showing a fraction of it (panning outward reveals more)
— confirmed the simplest of three considered designs was intended before touching
anything, since the alternatives (chunked lazy-loaded terrain, or a truly unbounded
computed-on-the-fly world) are a materially different architecture, not a tuning knob.

- **Grid**: `GRID_SIZE` 80→300 (`spacetimedb/src/index.ts`), applied to both running
  environments via `set_grid_size 300` (regenerates terrain at the new size in the same
  call, as designed back when that reducer was built — no separate terrain step
  needed). Terrain generation at 90,000 cells stayed a non-event: the `set_grid_size`
  CLI round-trip completed in ~160ms.
- **Population cap**: 60→50, via `set_population_cap 50` on both environments plus the
  `DEFAULT_POPULATION_CAP` source constant (for future fresh installs). Deliberately
  *not* scaled up with the 14×-bigger grid area — a capped, sparser, explorable world
  was the explicit intent.
- **Predator/flee search radii rescaled**: `FLEE_RADIUS` 4→15, `PREDATOR_HUNT_RADIUS`
  12→45 (same ~5%/~15%-of-grid proportions as before). Not asked for directly, but a
  necessary consequence of the grid change: at the old fixed cell counts, a predator's
  search circle covers a shrinking fraction of an ever-larger, ever-sparser grid — left
  unscaled, predators would rarely find anything to hunt, silently breaking a feature
  that was otherwise working. Flagged rather than silently fixed.
- **Camera default view**: `app/WorldCanvas.tsx` now treats "fit the whole world" and
  "the default starting view" as two different numbers. `minZoomRef` (zooming all the
  way out) is still a genuine whole-world fit with a small margin, unchanged in
  spirit from before. The *starting* view (first load, or pressing `0`) is now
  `INITIAL_VIEW_FRACTION` (18%) of the world — collapsing these back into one "fit"
  concept was explicitly the thing to avoid, since that's what made a 300-cell world
  look nearly empty at first glance.

**A real bug found and fixed in the middle of this**, not part of what was asked but
directly blocking verification of it: predators deleting prey mid-tick could crash the
tick reducer on every subsequent firing (see the gotcha above). Both environments were
down — ticks frozen, not just slow — for some window before this was noticed and fixed.
Verified the fix directly: `tick_count` resumed advancing within seconds of republishing
on both `local` and `maincloud`, and a follow-up 5-second check showed 3 ticks elapsing
(matching the 2-second interval) with no further panics in `spacetime logs`.

**Verified after all of the above, via a scripted subscribe**: `world_config.gridSize`
reads 300 on `local`, `terrain.cells.length` is exactly 90,000 (300²) confirming the
regenerated terrain matches the new size, `populationCap` reads 50, and live creature
count (33 at the time of the check) sits under the new cap. `tsc --noEmit` and the
module build are both clean after every change in this round.

**Update, found immediately after writing the above**: that "33 creatures, 121 food"
snapshot wasn't stable — it was mid-collapse. A follow-up check found population at 1.
Not a second crash (`tick_count` had advanced normally, no panics in the logs) — the
grid growing 80→300 without food density growing with it meant creatures were starving
before reaching food, at real ecological scale. See the new gotcha above ("Growing
`GRID_SIZE` without also growing food density..."). Fixed by scaling
`foodCap`/`foodSpawnPerTick` from 120/5 to 350/15 (roughly 3x, not the full ~14x that
would preserve the original density — a deliberate tradeoff against untested canvas
draw cost on mobile, see CLAUDE.md), applied live to both environments via
`set_food_config`, and both environments reseeded again with food-seeking test
creatures (population had gone fully to zero on both by the time this was caught).

**Follow-up, watched for a further ~2 minutes on both environments**: population did
**not** continue collapsing — it stabilized, with genuine reproduction mixed into the
starvation deaths in the event log the whole time (`#1367 reproduced -> #1375`, etc.,
interleaved with `died of starvation`, on both `local` and `maincloud` independently).
So 350/15 is alive, not a slower collapse. But it settled at a much lower population
than the 50 cap — **8 on `local`, 4 on `maincloud`** at last check, not climbing toward
50 in any of the observed window. Reporting this plainly rather than rounding up to
"fixed": at this food density, reaching the reproduce-energy threshold (which needs
several successful meals) appears to be rare enough that the population finds a low
equilibrium well under cap, rather than growing toward it the way the original
50/120-food-cap/80×80-grid combination did. **This is an open tuning question, not a
resolved one** — if you want the population to actually climb toward 50, `foodCap`/
`foodSpawnPerTick` likely need to go higher than 350/15 (`set_food_config`, live, no
republish); I picked 350/15 as a moderate first cut specifically to avoid guessing too
aggressively on canvas draw cost, and it turned out conservative on the ecology side
instead. Also still unverified: the predator search-radius rescaling's actual effect on
hunt success rate at this scale, and — the standing limitation through this whole
session — what any of this looks like on an actual screen.

## Checkpoint 5: LLM-matched emoji + habitat, manual predator spawn, visible size growth, live tick speed, fullscreen

Four things asked together, plus two mid-turn additions (visible size growth, tick
speed control), plus a fullscreen toggle asked for afterward.

- **Emoji glyph now genuinely matches the prompt.** `CREATURE_COMPILE_SYSTEM_PROMPT`
  requires a real emoji (`"🦂" for a scorpion`, not a letter). `DEFAULT_CREATURE_PARAMS.glyph`
  changed from `'C'` to `'🦠'` so even the fallback path fits the theme.
- **Spawn location is now habitat-biased, not pure random.** The LLM also returns a
  `habitat` field (`bloom`/`cold`/`vent`/`barren`/`any`), inferred from environmental
  cues in the prompt text. `pickSpawnPosition()` reservoir-samples a matching-biome
  cell from `terrain.cells` in one pass.
- **`spawnPredator` reducer** — manual predator spawn, gated by the same
  `PREDATOR_MAX_ACTIVE` (2) cap as the automatic ecological trigger.
- **Size growth bumped for visibility**: `SIZE_GROWTH_PER_MEAL` 0.05→0.15, so a
  well-fed creature can triple in size (`MAX_SIZE` 3, starting size 1) within a normal
  session — canvas already sizes the emoji font off `size`, so this alone is enough to
  make growth read as dramatic on screen, no rendering changes needed.
- **`setTickSpeed(intervalMicros)`** — updates `tick_schedule.scheduledAt` (the real
  firing rate) and `world_config.tickIntervalMicros` (a client-readable mirror) in the
  same call. New `tickIntervalMicros` column on `world_config` (appended at the end,
  per the column-ordering gotcha above — non-destructive publish on both environments).
- **Fullscreen toggle** on the canvas — native `requestFullscreen()`/`exitFullscreen()`,
  a button in the top-right corner, state tracked via the `fullscreenchange` event
  (covers Esc-to-exit, not just the button). No changes needed to the sizing/camera-fit
  pipeline — it already measures the container's actual `getBoundingClientRect()`.

**Two real bugs found during verification, not part of what was asked:**

1. `LLM_MAX_TOKENS` at 500 measurably truncated ~13% of live spawns before reaching the
   newly-added `glyph`/`habitat` fields (see the gotchas section above) — bumped to 800.
2. `setTickSpeed` silently no-opped the actual reschedule the first time it was
   published: `tick_schedule.scheduledId` is `autoInc`, so its live row id isn't `0n`
   the way `world_config`/`terrain`'s fixed-id singleton rows are. `.scheduledId.find(0n)`
   found nothing, so only the `world_config.tickIntervalMicros` mirror updated while the
   real tick rate kept running at the old interval — no error anywhere, just a client
   that silently drifted from the server's actual cadence. Caught by measuring real
   `tick_count` progression over a wall-clock window instead of trusting the reducer's
   apparent success. Fixed by looking the row up via `[...ctx.db.tick_schedule.iter()][0]`.

**Verified directly, in order:**

- `npx tsc --noEmit` and `next build` both clean after every change in this round.
- Habitat inference + placement: spawned `"a fire-breathing salamander that thrives in
  volcanic heat"` on `local` → response said `"spawned near a thermal vent"`; cross-checked
  the creature's actual `(x, y)` against `terrain.cells` directly — it landed exactly on
  a vent-biome cell (biome index 2), not just a plausible-sounding claim in the summary text.
- Manual predator spawn: `spawn_predator` twice succeeded, a third call correctly
  rejected with `"Already at the predator cap (2)"`.
- Emoji matching: seeded 30 varied one-line prompts on both `local` and `maincloud`
  (30 each). Spot-checked the full `glyph` column on both — real, specific matches
  throughout (🦋 moth, 🐧 penguin, 🦉 owl, 🦀 crab, 🦎 chameleon, 🦅 falcon, 🐍 snake,
  🦭 walrus, etc.), not arbitrary letters. Found and fixed the ~13%-truncation issue
  above as a direct result of this check.
- Size growth: after the two batches of seeding ran for a while under normal tick
  progression, several `local` creatures had already reached `MAX_SIZE` (3, from a
  starting size of 1) — a genuine 3x size range exists to render, confirmed via
  `spacetime sql`, not just asserted from the constant change.
- Tick speed: `set_tick_speed 500000` (0.5s) on `local` made `tick_count` advance 10
  ticks in a measured 5-second window (exactly the expected 2 ticks/sec) — confirmed
  only *after* finding and fixing bug #2 above; the first attempt looked like it worked
  (no error) but measurably wasn't changing the real cadence. Reset both environments
  back to `2000000` (2s) afterward.
- Fullscreen: implemented and typechecked; **not verified visually** — no browser
  available this session (see the standing limitation noted throughout this file).

**Population, honestly reported:** seeding 30 fresh creatures (on top of a
starting-from-zero population on both environments — an unrelated schema-publish cycle
had brought both down to 0 beforehand) produced real reproduction in the event log, but
net population still trended down over the following minutes rather than climbing
toward the 50 cap: 32 → 15 on `local`, 32 → 8 on `maincloud`. Same open tuning question
as Checkpoint 4 — starvation is outpacing reproduction at the current 350/15
food config. Not fixed in this round; noted rather than glossed over.

**Seeding commands** (30 random creatures + a predator), for reuse:

```bash
# Seed all 30 prompts in scripts/seed_prompts.txt in one go (one spawn_from_prompt
# call per line, habitat-biased placement, real LLM-matched emoji per creature):
bash scripts/seed.sh                     # --server local (default)
bash scripts/seed.sh --server maincloud  # or the live deployment

# Spawn a predator manually (world-only mechanic, capped at PREDATOR_MAX_ACTIVE = 2):
spacetime call prompt-wars spawn_predator --server local
```

`scripts/seed_prompts.txt` is plain text, one creature description per line — edit it
directly to change the seed set (different themes, more/fewer creatures); `scripts/seed.sh`
just loops it through `spawn_from_prompt`. Each call is a real Groq round-trip, so the
full file takes a couple of minutes — expected, not a hang. **Re-run this whenever the
world looks empty** — see the food-tuning note above: at the current 350/15 config,
population has been observed not just declining but going fully extinct on both
`local` and `maincloud` (0 creatures, ticks still advancing normally) after being left
unattended for a while. Reseeding brings it back, but doesn't fix the underlying
imbalance — if this keeps happening, `set_food_config` needs a real bump, not another
reseed.

## Checkpoint 6: profile names + a full "how do I ship a value change" checklist

Two asks: (1) a clear, reusable checklist for "I changed a value in
`spacetimedb/src`, now what" so it doesn't have to be re-derived every session; (2) a
profile-name feature — the latest name a player adds via the People form should show
as initials above whichever creature(s) they've spawned.

- **The checklist** is now its own section near the top of this file ("Changing a
  value in `spacetimedb/src/index.ts` — the full checklist"), covering build → publish
  local → generate → typecheck/build the client → exercise the change via CLI →
  publish Maincloud → generate again → what actually needs a dev-server restart vs. a
  new Vercel deploy for the running UI to pick it up.
- **Profile names**: `person` gained `owner: t.option(t.identity())` and
  `createdAt: t.timestamp()` (both appended, both defaulted so the migration was
  non-destructive — see CLAUDE.md for exactly why each needed `.default(...)`, since a
  first attempt without it was rejected: *"Adding a column owner to table X requires a
  default value annotation"*, even for an Option type). `creature` gained the same
  `owner` column. `add` now stamps `owner: ctx.sender, createdAt: ctx.timestamp` on
  every insert (still append-only — no upsert, the guestbook itself didn't change).
  `spawnFromPrompt` stamps the spawning identity onto the new creature; reproduction
  copies the parent's `owner` onto the child, so a whole lineage stays tagged to
  whoever originally spawned it; seed/predator creatures keep `owner: undefined`.
  `app/WorldView.tsx` reduces all subscribed `person` rows to "latest name per
  identity" (max `createdAt`, grouped by `owner.toHexString()`) and passes a
  `Map<hexIdentity, initials>` down; `app/WorldCanvas.tsx` looks the label up at
  *draw time* from a creature's `owner`, not baked into the interpolation entry once,
  so re-submitting your name relabels your creatures within a frame.
- **A real bug caught only by `next build`, not `tsc`:** `Identity`/`Timestamp` are
  class instances. `app/page.tsx` is a Server Component that fetches initial `person`
  rows server-side and passes them into the client `<PersonList>` — once those rows
  carried `owner`/`createdAt`, Next's server→client prop serialization broke with
  *"Only plain objects, and a few built-ins, can be passed to Client Components from
  Server Components"*, only surfacing during the production build's prerender step.
  Fixed by narrowing `lib/spacetimedb-server.ts`'s `fetchPeople()` (and its exported
  `PersonData` type) to `{ name }` only — the SSR path never needed the rest, and the
  live `useTable` path (entirely client-side, never crossing that boundary) is
  unaffected. **Lesson applied going forward:** `npx tsc --noEmit` alone is not
  sufficient verification for a schema change touching anything passed through a
  Server Component prop — `npm run build` is now step 4 of the checklist above, not
  optional.

**Verified:**

- `spacetime build`, publish (both environments, non-destructive both times after the
  `.default(...)` fix), `spacetime:generate`, `npx tsc --noEmit`, and `npm run build`
  all clean, in that order, on the actual final code.
- `add "TestUser"` then `add "Zebra"` under the same CLI identity on `local` →
  `SELECT * FROM person` shows both rows with the same `owner` and increasing
  `created_at`, confirming "latest wins" has real data to work correctly against.
- `spawn_from_prompt` on that same identity → the new creature's `owner` column
  matches the identity that also submitted "Zebra", confirmed via `spacetime sql`.
- **Not verified visually** — no browser available this session (the standing
  limitation noted throughout this file). The label-drawing code is typechecked and
  the underlying data/reduction logic is confirmed correct via the two checks above,
  but the actual on-canvas rendering (position above the glyph, legibility, whether
  two nearby players' labels overlap) has not been seen on an actual screen.
