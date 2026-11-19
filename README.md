# @marianmeres/migrate

[![NPM version](https://img.shields.io/npm/v/@marianmeres/migrate.svg)](https://www.npmjs.com/package/@marianmeres/migrate)
[![JSR version](https://jsr.io/badges/@marianmeres/migrate)](https://jsr.io/@marianmeres/migrate)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

A general-purpose, extensible versioning framework for managing incremental, bidirectional
changes.

Possible use cases include:

- database migrations
- undo/redo systems
- progress tracking
- install/uninstall systems

## How does it work?

Under the hood, it is essentially an ordered collection of `up` and `down` callback pairs,
each labeled with a semantic version string. Every upgrade or downgrade is then a serial
execution of the relevant `up` or `down` callbacks.

## Installation

```sh
npm install @marianmeres/migrate
```

```sh
deno add jsr:@marianmeres/migrate
```

## Usage

```js
import { Migrate } from "@marianmeres/migrate";
```

## Main API

```typescript
// the context is handed to every worker and option callback, and its type is inferred
const m = new Migrate(options?, context?);

// add available versions with migration functions
m.addVersion('1.2.3', upFn, downFn, optionalComment);

// register an irreversible (one-way) migration with `null` for down
m.addVersion('1.2.4', upFn, null, 'one-way');

// remove a version (any but the active one)
await m.removeVersion('1.2.4');

// get/set the system's current version (initially undefined)
await m.setActiveVersion('7.8.9');
const current = await m.getActiveVersion();

// migrate up or down (returns the number of applied steps)
await m.up('latest' | 'major' | 'minor' | 'patch' | version);
await m.down('initial' | 'major' | 'minor' | 'patch' | version);

// complete removal (downgrades past the initial version)
await m.uninstall();

// inspect without mutating state: up(), down() and uninstall() run exactly their plan
const plan = await m.plan('up', 'latest');     // { direction, fromVersion, toVersion, steps }
const status = await m.status();                // { active, latest, isAtLatest, pending }

// recovery helper — write the active-version marker without
// validating against the registered set (e.g. after a partial failure)
await m.forceSetActiveVersion('1.2.3');
```

Concurrent calls to `up()`, `down()` and `uninstall()` on the same `Migrate` instance are
automatically serialized.

A `down()` or `uninstall()` whose path crosses an irreversible version is refused before any
of it runs, and `plan()` shows it upfront (`reversible: false` on the step).

A failed worker is rethrown with the original error as its `cause`.

For the complete API reference, including all methods, types and semver utilities, see
[API.md](./API.md). The semver utilities (`normalizeSemver`, `parseSemver`,
`compareSemver`) are re-exported from the standalone
[@marianmeres/semver](https://jsr.io/@marianmeres/semver) package.

## Database helpers

For PostgreSQL and SQLite, the storage side is ready-made. Each helper returns a `Migrate`
instance that:

- keeps the active version in a table (`__migrate__` by default, created when missing),
- lets only one run happen at a time, across processes,
- makes every step atomic: either the version's worker and the write of the active version
  both take effect, or neither does.

Neither helper adds a dependency. You pass in your own `pg` pool or `node:sqlite`
database, and optionally `{ table, context, logger }`.

### PostgreSQL

```typescript
import { createPgMigrate } from "@marianmeres/migrate/pg";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const migrate = createPgMigrate(pool);

migrate.addVersion(
    "1.0.0",
    ({ client }) => client.query("create table users (id serial primary key)"),
    ({ client }) => client.query("drop table users"),
);

await migrate.up();
```

A run checks one connection out of the pool, holds a session advisory lock on it and opens
a transaction per step. Workers receive that connection as `client`. A second process
waits for the first, then finds nothing left to do.

### SQLite

```typescript
import { createSqliteMigrate } from "@marianmeres/migrate/sqlite";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("app.db", { timeout: 5000 });
const migrate = createSqliteMigrate(db);

migrate.addVersion(
    "1.0.0",
    ({ db }) => db.exec("create table users (id integer primary key)"),
    ({ db }) => db.exec("drop table users"),
);

await migrate.up();
```

A run is one `BEGIN IMMEDIATE` transaction, which takes SQLite's write lock, with a
savepoint per step. The helper is for `node:sqlite`, the SQLite module built into Node, and
takes its `DatabaseSync`. The busy timeout (`timeout`) is how long another connection waits
for a run in progress; without one, that connection fails at once with "database is
locked".

### Before you rely on them

- **Postgres commits each step, SQLite the whole run.** SQLite has no advisory lock, so
  the run's write transaction is the lock, and it commits once, at the end. A process
  that dies mid-run therefore loses every step of that run on SQLite (the database stays
  consistent, and the next run starts over), while Postgres keeps the steps it completed.
  A step that _fails_ is undone on both, and the steps before it are kept.
- **Workers always run inside a transaction.** A statement that cannot run in one, or has
  no effect there, cannot be issued by a worker: `create index concurrently` on Postgres,
  `VACUUM` or `PRAGMA foreign_keys` on SQLite. Nor may a worker issue `begin`, `commit` or
  `rollback` itself. For such a version, use the core `Migrate` with your own hooks (see
  [Atomic steps and locking](#atomic-steps-and-locking)).
- **Postgres needs a real session.** Connect directly, or through a pooler in session
  mode, not PgBouncer in transaction mode: the advisory lock belongs to the database
  session, which a transaction-mode pooler does not keep between statements.
- **A SQLite run owns its database handle.** Anything else written through the same
  `DatabaseSync` while a run is in progress becomes part of the run's transaction.

A step-by-step walkthrough of a run and the full reference are in
[API.md](./API.md#database-helpers).

## Atomic steps and locking

The database helpers are built on two optional hooks, which do the same for any other
store. Each receives a `run` callback, which it must call and await exactly once.

- `wrapStep(run, step, context)` wraps a single step: the version's worker **and** the
  write of the active version. Make it a transaction, and the two commit together or not at
  all.
- `wrapRun(run, info, context)` wraps a whole `up()` / `down()` / `uninstall()`, the read
  of the active version included. Make it a lock, and two processes can never migrate the
  same system at once.

```typescript
const m = new Migrate(
    {
        getActiveVersion: ({ client }) => readVersion(client),
        setActiveVersion: (version, { client }) => writeVersion(client, version),
        wrapRun: async (run, info, { client }) => {
            await client.query("select pg_advisory_lock(42)");
            try {
                await run();
            } finally {
                await client.query("select pg_advisory_unlock(42)");
            }
        },
        wrapStep: async (run, step, { client }) => {
            await client.query("begin");
            try {
                await run();
                await client.query("commit");
            } catch (e) {
                await client.query("rollback");
                throw e;
            }
        },
    },
    { client }, // one connection for the whole run
);
```

Without `wrapStep`, a process that dies between a worker and the write of the active
version leaves that version applied but not recorded, and the next `up()` runs it again.

## Versions are applied in order, once

Only one value is stored: the active version. Which versions ran is not recorded, and
`up()` runs the registered versions above the active one. A version registered later
_below_ the active one is therefore never applied, and never reported as pending.

So number a new version above the highest one already applied anywhere and, as the
example's loader does, treat a version that fails to load as an error instead of skipping
it.

## Database migration example

The [PostgreSQL example](./example/) is a small CLI on top of `createPgMigrate`: every
`example/<semver>/migrate.ts` exports an `up` and (unless the version is one-way) a
`down`, and `example/db-migrate.ts` loads them and runs the requested migration. After
`pnpm install`, copy `.env.example` to `.env`, fill in the connection details, and run it
with Node:

```sh
node --env-file=.env example/db-migrate.ts --up --target=latest
node --env-file=.env example/db-migrate.ts --down --target=1.1.0
node --env-file=.env example/db-migrate.ts --uninstall
```

## Undo / redo example

Without a database, the same machinery is an undo/redo history, or a progress tracker for
any multi-step process. Every action becomes the next major version (`1.0.0`, `2.0.0`,
...), with the action as its `up` and its reversal as its `down`. `down()` goes one major
version back by default, so it undoes one action, and `up("major")` redoes one.

```typescript
import { Migrate } from "@marianmeres/migrate";

const doc: string[] = []; // the state being edited
const history = new Migrate();
let sequence = 0;

// Version 0 is the empty document, so that the first action can be undone too
await history.setActiveVersion(history.addVersion("0", () => {}, () => {}));

/** Records an action as the next version, then applies it. */
async function act(up: () => unknown, down: () => unknown) {
    // A new action discards what was undone before it: it can no longer be redone
    for (const undone of (await history.status()).pending) {
        await history.removeVersion(undone);
    }
    history.addVersion(`${++sequence}`, up, down);
    await history.up();
}

const undo = () => history.down(); // one version back
const redo = () => history.up("major"); // one version forward

const add = (word: string) => act(() => doc.push(word), () => doc.pop());

await add("hey");
await add("ho");
await add("let's");
await add("go");    // doc: ["hey", "ho", "let's", "go"], active version: 4.0.0

await undo();
await undo();       // doc: ["hey", "ho"]
await redo();       // doc: ["hey", "ho", "let's"]

await add("rock");  // doc: ["hey", "ho", "let's", "rock"], and "go" is gone
await redo();       // 0: nothing to redo

await history.down("initial"); // doc: [], back at version 0
await undo();                  // 0: nothing to undo
await history.up();            // doc: ["hey", "ho", "let's", "rock"]
```

`undo()` and `redo()` return the number of steps taken, and
`(await history.status()).pending` lists what can still be redone.

## Upgrading from 1.x

- `down()` and `uninstall()` refuse a path that crosses an irreversible version before
  running anything. In 1.x they ran the reversible versions above it, then threw.
- `getActiveVersion` and `setActiveVersion` must be given together: the constructor throws
  when only one is.
- The context is typed. `Migrate`, `Version`, `MigrateFn` and `MigrateOptions` take a
  context type parameter, inferred from the constructor's second argument. Workers receive
  the context as a required argument (it was optional and `Record<string, unknown>`), and
  may return anything.
- Plan steps carry `reversible`, and `plan()` also takes `"uninstall"`.
- `status().pending` lists the versions above the active one by semver order. With an active
  version that is not registered, 1.x listed every version.
- Errors carry the original error as `cause`. The error for a failed down worker reads "The
  downgrade from version ..." (was "to"), and a failed uninstall reports the failing step
  like any other downgrade.
- `setActiveVersion()` writes to the external store first: when that throws, the in-memory
  active version does not move.
- New: the `@marianmeres/migrate/pg` and `@marianmeres/migrate/sqlite` helpers, the
  `wrapStep` and `wrapRun` hooks, and `removeVersion()`.

## Development

Node LTS (`.node-version`), pnpm, Biome, `node:test`. The source is erasable-only
TypeScript that Node runs directly; `dist/` is built only for publishing to npm. JSR is
served the `.ts` source (`jsr.json`).

| Command                             | Does                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| `pnpm install`                      | installs the dev tooling                                 |
| `pnpm test` / `pnpm run test:watch` | `node --test` over `tests/**/*.test.ts` (see below)      |
| `pnpm run test:deno`                | the same suite on Deno, resolved as JSR consumers see it |
| `pnpm run typecheck`                | `tsc --noEmit` over `src`, `tests` and `example`         |
| `pnpm run lint` / `pnpm run format` | `biome check .` read-only / with `--write`               |
| `pnpm run ci`                       | typecheck + lint + test, what CI runs                    |
| `pnpm run build`                    | `tsc -p tsconfig.build.json` → `dist/`                   |
| `pnpm run jsr:check`                | `deno publish --dry-run` with the `package.json` version |
| `pnpm run rp` / `pnpm run rpm`      | patch / minor release, then publish to npm and JSR       |

The Postgres helper is also tested against a real server. `pnpm test` reads `.env` when
there is one (see `.env.example`) and runs those tests in that database, in tables with a
random prefix that it drops afterwards. Without `DB_DATABASE` they are skipped, except in
CI, where they fail.
