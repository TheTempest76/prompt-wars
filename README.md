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
- **Your CLAUDE.md said `table({ scheduled: ... })`.** That form is deprecated in SDK
  2.10.0. Use `spacetimedb.reducer({ onSchedule: someTable }, ...)` instead — the schema
  and the reducer can live in separate files this way, which matters once `index.ts`
  gets split up. See Checkpoint 2.
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
