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
  project: the one-shot LLM call at creature spawn.
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

### Publishing to Maincloud (the persistent, always-on deployment)

```bash
npm run spacetime:publish        # publishes spacetimedb/ to Maincloud as "prompt-wars"
```

Point the client at Maincloud by editing `.env.local`:
```
SPACETIMEDB_HOST=wss://maincloud.spacetimedb.com
NEXT_PUBLIC_SPACETIMEDB_HOST=wss://maincloud.spacetimedb.com
```
(`SPACETIMEDB_DB_NAME` / `NEXT_PUBLIC_SPACETIMEDB_DB_NAME` stay `prompt-wars`.)

### Other useful commands

```bash
spacetime logs prompt-wars --server local -f        # tail module logs (console.log from reducers)
spacetime sql prompt-wars --server local "SELECT * FROM person"   # ad-hoc query
spacetime publish --module-path spacetimedb --server local --delete-data=always --yes prompt-wars
                                                     # wipe + republish (schema conflict escape hatch)
```

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
  secrets story for the OpenAI key — see Checkpoint 4 for how we handle it (a private
  table + an owner-only reducer to set it, never sent to the client).
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
