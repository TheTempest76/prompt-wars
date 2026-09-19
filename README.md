# prompt-wars

A shared, always-on 2D world where creatures you describe in plain English are compiled
by an LLM into real simulation parameters — then live, eat, grow, reproduce, and die on
a scheduled tick that keeps running whether or not anyone is watching.

> **Note:** the hosted database connection has been removed, so the deployed site no
> longer points at a live world. Everything still works — the same steps below run the
> whole thing locally (your own SpacetimeDB server, your own world, your own API key),
> and the same steps also apply if you want to host it yourself.

---

## Table of contents

- [What it is](#what-it-is)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Setting up SpacetimeDB](#setting-up-spacetimedb)
- [Setting up the LLM API key](#setting-up-the-llm-api-key)
- [Common commands](#common-commands)
- [Project structure](#project-structure)
- [Deployment](#deployment)
- [Further documentation](#further-documentation)
- [License](#license)

---

## What it is

Type a description — *"a frost wolf hunting across arctic ice"* — and an LLM turns it
into a creature with a real emoji glyph, a colour, movement behaviour (does it seek
food? flee bigger things? how aggressive is it?) and a preferred habitat. The creature
is dropped into a biome that matches its description and joins everyone else's
creatures in one shared world.

From there nobody drives it. A scheduled reducer ticks roughly every 2 seconds and runs
the whole ecology:

- **Terrain** — four biomes (bloom, cold shelf, thermal vent, barren) generated as value
  noise, each with its own food-spawn rate and energy-burn rate that the simulation
  actually reads.
- **Energy, growth and death** — creatures burn energy every tick, gain it from food,
  visibly grow as they eat, shrink when starving, and die at zero.
- **Reproduction and mutation** — well-fed creatures spawn children with slightly
  mutated parameters, inheriting their parent's owner.
- **Predators** — world-spawned (never player-authored) when the population/food ratio
  signals pressure, rendered as sharp red diamonds, and bounded by kill count, energy
  and a hard active cap so they can't wipe the world unattended.
- **Live canvas** — a pannable, zoomable `<canvas>` world with smooth interpolation
  between ticks, an event log of births/deaths/predator activity, and initials above
  each creature showing who spawned it.

No refresh button exists anywhere: every client holds a WebSocket subscription and gets
row changes pushed to it.

## How it works

There is no API server in this project, and that isn't a shortcut — **SpacetimeDB is the
server**. The game logic runs inside the database process.

| Concept | What it means here |
|---|---|
| **Table** | A typed SQL table defined in TypeScript (`creature`, `food`, `terrain`, `world_config`, `event_log`, `person`). |
| **Reducer** | The only way to write to a table. Atomic, deterministic, no network, no clock, no return value. The tick is a *scheduled* reducer. |
| **Procedure** | Like a reducer but may make outbound HTTP calls and return a value. Used for exactly one thing: the spawn-time LLM call. |
| **Subscription** | How the client reads. It registers a query, gets matching rows immediately, then receives every future insert/update/delete live over the same WebSocket. |

So the flow is: client calls a reducer → the reducer commits a row change → every
subscribed client gets the change pushed → React re-renders. No REST endpoints, no
polling, no "fetch after mutate".

## Tech stack

- **Simulation / backend** — SpacetimeDB TypeScript module (`spacetimedb/src/index.ts`)
- **Client** — Next.js 15 (App Router) + React 18, TypeScript
- **Rendering** — plain Canvas 2D with a custom camera (no game engine, no sprites)
- **LLM** — Groq (`api.groq.com`, OpenAI-compatible chat completions)

## Prerequisites

- **Node.js** ≥ 18.18
- **SpacetimeDB CLI** — see [Setting up SpacetimeDB](#setting-up-spacetimedb)
- **A Groq API key** *(optional)* — without one, spawning still works, creatures just
  fall back to default parameters instead of LLM-compiled ones

## Getting started

```bash
# 1. Clone and install
git clone https://github.com/TheTempest76/prompt-wars.git
cd prompt-wars
npm install

# 2. Start the local SpacetimeDB server — leave this running in its own terminal
spacetime start

# 3. In a second terminal: publish the module to your local server
npm run spacetime:publish:local

# 4. Generate the client bindings from the published schema
npm run spacetime:generate

# 5. Configure the environment
cp .env.local.example .env.local

# 6. Run the app
npm run dev
```

Open **http://localhost:3001** — *not* 3000. SpacetimeDB's local server already owns
port 3000, so Next.js is pinned to 3001 in `package.json`.

Optionally, seed the world with ~30 creatures so it isn't empty on first look:

```bash
bash scripts/seed.sh                 # targets --server local
```

## Environment variables

Copy `.env.local.example` to `.env.local`. The browser bundle and the server component
read **separate** variables, so all of these must be set:

| Variable | Purpose | Local value |
|---|---|---|
| `SPACETIMEDB_HOST` | Server-side connection (used during SSR) | `ws://localhost:3000` |
| `SPACETIMEDB_DB_NAME` | Server-side database name | `prompt-wars` |
| `NEXT_PUBLIC_SPACETIMEDB_HOST` | Browser connection | `ws://localhost:3000` |
| `NEXT_PUBLIC_SPACETIMEDB_DB_NAME` | Browser database name | `prompt-wars` |
| `NEXT_PUBLIC_SITE_URL` | Origin used for absolute `og:image` URLs | optional locally |

`.env.local` is read once at startup — **restart `npm run dev`** after editing it.

Note that the Groq API key is deliberately *not* an environment variable. It lives in a
private table inside the database; see below.

## Setting up SpacetimeDB

### 1. Install the CLI

```bash
# macOS / Linux
curl -sSf https://install.spacetimedb.com | sh

# Windows (PowerShell)
iwr https://windows.spacetimedb.com -useb | iex
```

Official instructions: <https://spacetimedb.com/install>. Verify with `spacetime --version`.

### 2. Run a server locally (no account needed)

```bash
spacetime start                     # foreground; leave it running
spacetime server ping local         # confirm it's up
```

Then publish this project's module to it and generate the matching client bindings:

```bash
npm run spacetime:publish:local
npm run spacetime:generate
```

That's the entire "API": the published module *is* the backend, and
`src/module_bindings/` is the generated, fully-typed client for it. That directory is
100% generated — never hand-edit it.

### 3. (Optional) Host it on SpacetimeDB Maincloud

If you want a world that keeps ticking with nobody connected and no local server
running, publish to SpacetimeDB's hosted platform instead:

```bash
spacetime login                     # opens a browser; free account at spacetimedb.com
npm run spacetime:publish           # publishes to maincloud as "prompt-wars"
npm run spacetime:generate
```

Then point all four `SPACETIMEDB_*` variables at `wss://maincloud.spacetimedb.com`
(`wss://`, not `ws://` — Maincloud is TLS-only) and restart the dev server.

### Re-publishing after a change

Any time you add, remove, or rename a **table, column, reducer, procedure, or argument
type** in `spacetimedb/src/index.ts`, publish first and generate second, then restart
the dev server so Next.js picks up the new types:

```bash
spacetime build --module-path spacetimedb     # typecheck the module
npm run spacetime:publish:local               # publish
npm run spacetime:generate                    # regenerate bindings
```

If a schema change conflicts during development, the escape hatch is a wipe-and-republish:

```bash
spacetime publish --module-path spacetimedb --server local --delete-data=always --yes prompt-wars
```

## Setting up the LLM API key

Creature compilation uses [Groq](https://console.groq.com) (a `gsk_...` key — this is
Groq's fast-inference API, *not* xAI's similarly-named "Grok").

1. Create a free key at <https://console.groq.com/keys>.
2. Confirm the model id in `GROK_MODEL` (`spacetimedb/src/index.ts`) still exists at
   <https://console.groq.com/docs/models> — availability changes often.
3. Store the key **in the database**, not in an env file:

```bash
spacetime call prompt-wars set_llm_key '"gsk_your_key_here"' --server local
```

The first identity ever to call `set_llm_key` becomes its permanent owner, and only that
identity can rotate it afterwards. The key is never sent to the client and is never
accepted as a procedure argument from the browser.

Without a key, spawning still succeeds — creatures just use default parameters (a 🦠
glyph and generic behaviour) instead of LLM-compiled ones.

## Common commands

```bash
# App
npm run dev                                   # Next.js dev server on :3001
npm run build                                 # production build
npm run start                                 # serve the production build on :3001

# Module
npm run spacetime:publish:local               # publish to the local server
npm run spacetime:publish                     # publish to Maincloud
npm run spacetime:generate                    # regenerate src/module_bindings/

# Inspect a running world (no browser needed)
spacetime logs prompt-wars --server local -f                                  # tail reducer logs
spacetime sql  prompt-wars --server local "SELECT * FROM world_config"        # query state
spacetime describe prompt-wars --server local --json                          # published schema

# Tune the world live, without republishing
spacetime call prompt-wars spawn_from_prompt '"a frost wolf hunting arctic ice"' --server local
spacetime call prompt-wars spawn_predator --server local
spacetime call prompt-wars set_population_cap 60 --server local
spacetime call prompt-wars set_food_config 350 15 --server local              # cap, per-tick spawn
spacetime call prompt-wars set_tick_speed 500000 --server local               # microseconds (4x faster)
spacetime call prompt-wars set_biome_multipliers 2 2.5 1.8 --server local     # biome, food x, burn x
spacetime call prompt-wars regenerate_terrain --server local
```

Reducers use their **snake_case** wire name on the CLI, even though they're exported in
camelCase from TypeScript.

## Project structure

```
prompt-wars/
├── spacetimedb/src/index.ts   # the entire simulation: tables, tick, LLM procedure
├── src/module_bindings/       # generated client bindings — never hand-edit
├── app/                       # Next.js App Router
│   ├── page.tsx               # landing page
│   ├── world/page.tsx         # the world route
│   ├── WorldView.tsx          # the one place that subscribes to tables
│   ├── WorldCanvas.tsx        # canvas renderer: camera, pan/zoom, interpolation
│   ├── SpawnCreature.tsx      # the spawn form
│   └── providers.tsx          # SpacetimeDB connection setup
├── lib/spacetimedb-server.ts  # the server-side (SSR) read path
├── scripts/seed.sh            # bulk-spawn the prompts in seed_prompts.txt
├── public/                    # static branding images
└── docs/README-archive.md     # the original long-form README / build log
```

## Deployment

The Next.js app is a zero-config Vercel deploy — no `vercel.json` needed. Point its
environment variables at a hosted SpacetimeDB (Maincloud) database rather than
`localhost`, applied to Production, Preview and Development so every deployment shares
one world:

```
SPACETIMEDB_HOST=wss://maincloud.spacetimedb.com
SPACETIMEDB_DB_NAME=prompt-wars
NEXT_PUBLIC_SPACETIMEDB_HOST=wss://maincloud.spacetimedb.com
NEXT_PUBLIC_SPACETIMEDB_DB_NAME=prompt-wars
```

The Groq key is *not* part of this — it lives in the database's private `llm_secret`
table, set once per environment with `set_llm_key`.

New *data* reaches a deployed site instantly over the WebSocket subscription, but a new
table/column/reducer *shape* needs a redeploy so the bundled `src/module_bindings/`
matches the published schema.

## Further documentation

| Document | What's in it |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | "I want to change X — where do I look?", as a lookup table |
| [`CLAUDE.md`](CLAUDE.md) | API correctness notes and the design decisions already settled |
| [`docs/README-archive.md`](docs/README-archive.md) | The original long-form README: full build log, every gotcha hit, checkpoint history |

## License

See [`LICENSE`](LICENSE).
