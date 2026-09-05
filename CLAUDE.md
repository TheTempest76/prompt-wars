# prompt-wars — SpacetimeDB Project Notes

A shared 2D world where a scheduled reducer ticks creatures forever, whether or not
anyone is connected. Stack: **TypeScript module** (`spacetimedb/`) + **Next.js/React
client** (`app/`, `lib/`). No other server languages, no other client frameworks —
trim any instinct to reach for Rust/C#/C++ module patterns or Angular/Vue/Svelte/Solid
client patterns; they don't apply here.

For the "what is a table/reducer/why no API server" mental model and copy-pasteable
commands, see `README.md`. For "where do I change X" once game logic exists, see
`ARCHITECTURE.md`. This file is API correctness + the decisions already made, so they
aren't re-derived or re-argued every session.

## This project's decisions (pinned — don't re-litigate these)

- **Ports:** SpacetimeDB local server on `3000`, Next.js dev/start pinned to `3001`
  (`next dev -p 3001` in `package.json`). They silently fight over `3000` otherwise —
  see README gotchas.
- **Database name:** `prompt-wars`, both on `local` and on `maincloud`.
- **Grid:** fixed 40×40. **Tick interval:** ~2 seconds, via a scheduled reducer.
  **Population cap:** a tunable column on `world_config`, not a constant — must be
  changeable via a reducer without republishing.
- **Determinism:** don't rely on bare `ctx.random()` for anything you need to explain
  after the fact — it's seeded from `ctx.timestamp`, not from table state. Store an
  explicit `rngSeed: t.u64()` column on `world_config` and advance it yourself each
  tick, so tick N's outcome is derivable from tick N's row data alone.
- **LLM provider: Groq (api.groq.com), not Claude/OpenAI/xAI.** Easy to confuse with
  xAI's unrelated "Grok" — a `gsk_...` key prefix means Groq. `GROK_MODEL` in
  `spacetimedb/src/index.ts` names the exact model id — verify it against
  https://console.groq.com/docs/models before relying on it, availability changes often.
  Every general-purpose model on a fresh key is a **reasoning model**, which burns
  `max_tokens` on an internal `reasoning` field before `content` — see
  `LLM_MAX_TOKENS`/`reasoning_effort` and the README gotchas for what that broke the
  first time.
- **LLM secret:** a private `llm_secret` table, written by `setLlmKey` — the *first*
  identity ever to call it becomes the permanent owner (checked via `ctx.sender.equals`),
  and only that identity can rotate it later. Never accept the key as a client-supplied
  argument — procedure arguments come from the browser and are public.
- **No auth, no accounts.** Anonymous identity only. A stranger must be usable within
  30 seconds of opening the URL. Don't add login, OIDC, or a token exchange flow.

## Critical Rules

1. **Reducers are transactional.** They do not return data to callers. Use
   subscriptions to read data.
2. **Reducers must be deterministic.** No filesystem, network, external clocks, or
   external random sources. Use `ctx.timestamp` and `ctx.random`, but see the
   determinism decision above — an explicit `rngSeed` column beats bare `ctx.random()`
   whenever you need to explain *why* something happened after the fact.
3. **Read data via tables/subscriptions**, not reducer return values.
4. **Auto-increment IDs are not sequential.** Gaps are normal; never use them for
   ordering. Use timestamps or an explicit sequence column.
5. **`ctx.sender` is the authenticated principal.** Never trust identity passed as a
   reducer/procedure argument.

## Feature checklist for any new piece of gameplay

1. Backend: define the table(s)
2. Backend: define the reducer(s)/procedure(s) that mutate them
3. Client: subscribe to the table(s) (`useTable`)
4. Client: call the reducer/procedure from UI (`useReducer` / `useProcedure`)
5. Client: render the data

## Validating the SpacetimeDB half without touching the browser

```bash
spacetime server ping local                                      # is the server up
spacetime logs prompt-wars --server local -f                     # tail console.log/errors from reducers
spacetime sql prompt-wars --server local "SELECT * FROM person"  # read table state directly
spacetime call prompt-wars add '"Alice"' --server local          # invoke a reducer directly, no UI
spacetime describe prompt-wars --server local --json             # confirm published schema matches source
```

Use this loop for new gameplay: publish → `spacetime call` the reducer directly →
`spacetime sql`/`logs` to check the result — all before opening the browser. It's also
how you prove the tick survives with nobody connected: leave `logs -f` running, close
every tab, wait, watch the tick counter advance in the log/table with zero clients.

If something's broken, check in order: is `spacetime start` running → is the module
published (`spacetime logs` shows a recent publish, not stale) → are client bindings
regenerated (see below) → is the reducer actually being called (check `logs -f` while
you trigger it from the UI).

## Tables

- **Private** (default): only accessible by reducers and the database owner.
- **Public** (`public: true`): exposed for client subscription. Writes still only
  happen through reducers.

## Reducers, Procedures, Event Tables, Subscriptions

- **Reducer**: transactional, deterministic, cannot call the network, cannot return
  data — the only way to write to a table.
- **Procedure**: the *only* place allowed to make outbound HTTP calls
  (`ctx.http.fetch`, synchronous) or return a value directly to its caller. In this
  project: exactly one use, the spawn-time LLM call (Checkpoint 4). Never call an LLM
  from a reducer, and never call it more than once per creature.
- **Event table** (`event: true`): rows are never stored in the client cache —
  `count()`/`iter()` see nothing, only `onInsert` fires live. Don't use one for
  anything you want to render as a persisted list (e.g. a scrolling event log) — use a
  regular table and trim old rows in the tick instead.
- **Subscription**: client registers a query, gets matching rows immediately, then
  every future insert/update/delete for that query pushed live over the same
  WebSocket. This is the entire "no refresh button" mechanism.

## Identity

`ctx.sender` (an `Identity`) is the authenticated caller of the current reducer or
procedure — always use it for authorization checks, never a value passed as an
argument. `ctx.connectionId` is `ConnectionId | null` (one Identity can hold several
connections); null-check it before using it as a table key. This project has no login,
so every visiting browser just gets an anonymous Identity/token pair automatically —
nothing to configure.

## CLI quick reference (TypeScript module, local + Maincloud only)

```bash
# Build / publish / bindings, from the repo root (spacetime.json already points at ./spacetimedb)
npm run spacetime:publish:local     # spacetime publish --module-path spacetimedb --server local --yes prompt-wars
npm run spacetime:generate          # spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb
npm run spacetime:publish           # same, but --server maincloud

# Local server lifecycle
spacetime start                     # foreground; leave running in its own terminal
spacetime server ping local

# Escape hatch for a schema conflict during development
spacetime publish --module-path spacetimedb --server local --delete-data=always --yes prompt-wars
```

**Regenerate bindings any time you add/remove/rename a table, column, reducer,
procedure, or their argument types** in `spacetimedb/src/index.ts`. Publish first,
generate second — `src/module_bindings/` is 100% generated, never hand-edit it.

## TypeScript Server SDK

### Module structure

```typescript
import { schema, table, t } from 'spacetimedb/server';

const score_record = table(
  { name: 'score_record', public: true },
  { id: t.u64().primaryKey().autoInc(), owner: t.identity(), value: t.u32() }
);

const spacetimedb = schema({ score_record });   // ONE object, not spread args
export default spacetimedb;

export const addRecord = spacetimedb.reducer(
  { value: t.u32() },
  (ctx, { value }) => { ctx.db.score_record.insert({ id: 0n, owner: ctx.sender, value }); }
);
```

`ctx.db` accessors are the keys passed to `schema({...})`, verbatim, snake_case. Only
table definitions belong inside `schema({...})`. Named exports are reserved for
reducers/procedures/views/lifecycle hooks — keep ordinary helpers unexported.

Imports: schema builders (`schema`, `table`, `t`, `SenderError`, `ReducerCtx`,
`InferSchema`) come from `spacetimedb/server`; runtime value classes (`ScheduleAt`,
`Timestamp`, `ConnectionId`) come from the root `spacetimedb` package; `Range` comes
from `spacetimedb/server`.

If tables (`schema.ts`) are split from reducers (`index.ts`), re-export the schema
from the entry file: `export { default } from './schema';` — the published module's
entry file must default-export the schema.

### Column types actually used in this project

| Builder | JS type | Notes |
|---|---|---|
| `t.u32()` / `t.i32()` | number | grid coordinates, ages, counters |
| `t.u64()` | bigint | ids, `rngSeed`, timestamps-as-micros — use `0n` literals |
| `t.f32()` / `t.f64()` | number | energy, size, mutable float params |
| `t.bool()` | boolean | |
| `t.string()` | string | prompts, glyphs, plain-language behavior summary |
| `t.identity()` | Identity | owner/sender columns |
| `t.timestamp()` | Timestamp | |
| `t.timeDuration()` / `t.scheduleAt()` | TimeDuration / ScheduleAt | scheduled tables only |
| `t.option(inner)` | `inner \| undefined` | optional columns |
| `t.array(inner)` | array | e.g. mutation history |

Modifiers: `.primaryKey()`, `.autoInc()`, `.unique()`, `.index('btree')`, `.default(v)`
(only on a newly-appended, migration-safe column — never on a primary key/unique/autoInc
column).

### Indexes

Inline `.index('btree')` for a single column with no named accessor need. A named
`indexes: [{ accessor, algorithm: 'btree', columns: [...] }]` entry for a multi-column
index or an explicit accessor name. Filter takes an array in index column order; a
prefix scan passes the leading value bare.

### DB operations

```typescript
ctx.db.creature.insert({ ... });                       // insert (0n for autoInc pk)
ctx.db.creature.id.find(creatureId);                    // find by PK/unique → row | null
[...ctx.db.food.gridCell.filter(cell)];                 // filter → spread to Array
[...ctx.db.creature.iter()];                            // all rows → Array
ctx.db.creature.id.update({ ...existing, energy: e });  // update (spread + override)
ctx.db.creature.id.delete(creatureId);                  // delete by PK
```

`insert()` is on the table accessor and returns the inserted row (with server-assigned
autoInc fields). PK/unique/index accessors support lookup/mutation but have no
`insert()`.

### Reducer context

```typescript
type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;   // use this in helpers, never `any`

if (!row.owner.equals(ctx.sender)) throw new SenderError('unauthorized');
ctx.db.item.insert({ id: 0n, createdAt: ctx.timestamp });
```

Let exported reducer/procedure callbacks infer their context type; only annotate a
helper's context explicitly (as `ReducerCtx<InferSchema<typeof spacetimedb>>`), never
as `any` — that erases row types and can make bigint expressions infer as `number`.

### Scheduled tables (the tick)

`onSchedule` binds a reducer/procedure to its table — the two can live in separate
files with no circular import:

```typescript
const tickTimer = table(
  { name: 'tick_timer' },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() }
);

export const tick = spacetimedb.reducer(
  { onSchedule: tickTimer },
  { timer: tickTimer.rowType },
  (ctx, { timer }) => {
    // runs automatically on schedule; this row is auto-deleted after the call
  }
);

// seed once, e.g. in init():
ctx.db.tick_timer.insert({
  scheduledId: 0n,
  scheduledAt: ScheduleAt.interval(2_000_000n), // repeating, microseconds
});
```

The deprecated form is `table({ scheduled: () => reducerFn }, ...)` — don't use it,
even if you see it in older examples; prefer `onSchedule` on the reducer/procedure.

### Custom types

```typescript
const Position = t.object('Position', { x: t.i32(), y: t.i32() });
const Behavior = t.enum('Behavior', {
  seekFood: t.unit(),
  fleeLarger: t.object('FleeParams', { threshold: t.f32() }),
});
// Values: { tag: 'seekFood' } / { tag: 'fleeLarger', value: { threshold: 1.5 } }
```

### Procedures and outbound HTTP

The real shape, from `spawnFromPrompt` in `spacetimedb/src/index.ts` (Groq's API is
OpenAI-compatible chat completions — `POST https://api.groq.com/openai/v1/chat/completions`,
`Authorization: Bearer <key>`, response at `choices[0].message.content`; reasoning
models also populate `choices[0].message.reasoning`, which we don't read):

```typescript
export const spawnFromPrompt = spacetimedb.procedure(
  { prompt: t.string() },
  SpawnResult,                                    // t.object with a real return value
  (ctx, { prompt }) => {
    let params = DEFAULT_CREATURE_PARAMS;
    const secret = ctx.withTx(tx => tx.db.llm_secret.id.find(0n));
    if (secret) {
      try {
        const res = ctx.http.fetch(GROK_API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: GROK_MODEL, messages: [...] }),
          timeout: TimeDuration.fromMillis(LLM_TIMEOUT_MILLIS), // short — never block spawn on a slow API
        });
        if (res.status === 200) {
          const content = JSON.parse(res.text())?.choices?.[0]?.message?.content;
          if (typeof content === 'string') params = clampCreatureParams(JSON.parse(content));
        }
      } catch {
        // network error, timeout, bad JSON — fall through to DEFAULT_CREATURE_PARAMS.
        // The game must never be blocked on an external API.
      }
    }
    const child = ctx.withTx(tx => tx.db.creature.insert({ ...params, /* ... */ }));
    return { creatureId: child?.id, summary: describeCreatureParams(params) };
  }
);
```

Procedures are **synchronous** — `ctx.http.fetch` blocks and returns directly, no
`await`. Always set an explicit `timeout`. Do network I/O *outside* `ctx.withTx`;
procedures can't hold a transaction open while a request is in flight. `t.array(t.u8())`
values are `number[]` — wrap in `new Uint8Array(value)` before treating as binary.
Every field of the parsed response is validated and defaulted independently
(`clampCreatureParams`) — a partially-garbage response still yields a valid creature,
never a blocked spawn.

Never accept the API key as a procedure argument (it would come from the browser,
public by definition) — read it from the private `llm_secret` table instead.

## React client (Next.js App Router)

```typescript
// app/providers.tsx — 'use client'
const connectionBuilder = useMemo(() =>
  DbConnection.builder()
    .withUri(HOST).withDatabaseName(DB_NAME)
    .withToken(localStorage.getItem(TOKEN_KEY) || undefined)
    .onConnect(onConnect).onDisconnect(onDisconnect).onConnectError(onConnectError),
  []);
<SpacetimeDBProvider connectionBuilder={connectionBuilder}>{children}</SpacetimeDBProvider>

// any 'use client' component
const [rows, isReady] = useTable(tables.creature);
const [onlineOnly] = useTable(tables.creature.where(r => r.energy.gt(0)), {
  onInsert: (row) => console.log('spawned:', row.id),
});
const addPerson = useReducer(reducers.add);              // (...params) => Promise<void>
const spawn = useProcedure(procedures.spawnFromPrompt);   // (...params) => Promise<ReturnType>
```

Both hooks come from `spacetimedb/react`, queue calls made before the connection
exists, and flush them once it's up — safe to call immediately on mount.

**Gotchas:**
- `useTable` rows are `readonly`. Copy before sorting: `[...rows].sort(...)`.
- `bigint` (from `u64`/`i64` columns) can't be rendered directly in JSX — wrap it:
  `{Number(row.id)}` or `{String(count)}`.
- Generated bindings convert snake_case → camelCase, including row fields: a server
  column `trip_id` is `tripId` on the client.
