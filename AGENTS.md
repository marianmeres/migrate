# @marianmeres/migrate - Agent Reference

Machine-readable comprehensive documentation for AI agents and LLMs.

## Package Identity

```yaml
name: "@marianmeres/migrate"
version: "see package.json" # not repeated here: a release bumps package.json only
author: "Marian Meres"
license: "MIT"
repository: "https://github.com/marianmeres/migrate"
npm: "https://www.npmjs.com/package/@marianmeres/migrate"
jsr: "https://jsr.io/@marianmeres/migrate"
module_system: "ESM"
entry_point: "src/mod.ts"
subpath_entry_points: "./pg -> src/pg.ts, ./sqlite -> src/sqlite.ts (database helpers)"
stack: "TypeScript (erasable-only), Node LTS (.node-version), pnpm, node:test, Biome"
registries:
  npm: "dist/ built by tsc from src/ (gitignored), manifest package.json"
  jsr: "the .ts source, manifest jsr.json (no version; publish passes --set-version)"
runtime_support: "pure TypeScript, no runtime APIs: browser, Node and Deno alike"
```

## Purpose

A general-purpose extensible versioning framework for managing incremental, bi-directional changes.

## Use Cases

- Database migrations (ready-made helpers for PostgreSQL and SQLite; any other store through the options)
- Undo/redo systems (editor history, state management)
- Progress change tracking (multi-step workflows)
- Install/uninstall systems (feature flags, plugins)

## Core Concepts

### Version Model

- All versions normalized to semver: `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]`
- Input `"v1"` → normalized `"1.0.0"`
- Input `"1.2"` → normalized `"1.2.0"`
- Versions stored in sorted order using semver comparison

### Migration Model

- Each version has a required `up()` and an optional `down()` function
- `up()` executes when upgrading TO this version
- `down()` executes when downgrading FROM this version
- Omitting `down` (passing `null`/`undefined`) marks the version as **irreversible** — any `down()`/`uninstall()` whose path crosses it is refused before any step runs
- Context object passed to all migration functions and option callbacks; its type (`TContext`) is inferred from the constructor's second argument
- Only the active version is stored, never the set of applied ones: a version registered below the active one is never applied and never reported as pending

### Upgrade Strategy (Greedy)

- Goes as far as possible within constraints
- `up("latest")` → highest version
- `up("major")` → highest of next major (strictly greater major segment)
- `up("minor")` → highest within current major, strictly greater than current version
- `up("patch")` → highest within current major + minor, strictly greater than current version

Semver increments use full semver ordering (via `compareSemver`), so they correctly bridge prerelease → release boundaries (e.g. `up("patch")` from `1.0.0-alpha` can reach `1.0.0` / `1.0.x`).

### Downgrade Strategy (Conservative)

- Typically one step at a time
- `down("initial")` → first version (keeps it)
- `down("major")` → highest strictly-lower version in a previous major
- `down("minor")` → highest strictly-lower version in the same major
- `down("patch")` → highest strictly-lower version in the same major + minor
- `down()` → defaults to one major step down

### State Consistency

- When an external `getActiveVersion` is configured, it is the source of truth; every call reads through it and the in-memory active item is synced to match (avoids cold-start divergence between code-registered versions and the persisted marker).
- `up()` / `down()` / `uninstall()` on the same instance are **serialized** via an internal promise chain — concurrent calls run one at a time. Across processes, the `wrapRun` hook (a lock) does it.
- `up()` / `down()` / `uninstall()` execute exactly what `plan()` returns (`#run` → `plan` → `#execute` → `#runStep`): a dry-run cannot differ from a run.
- A step is the version's worker followed by the marker write. The `wrapStep` hook (a transaction) makes the two atomic; without it, a partial failure (migration ran, marker write failed) throws a clear "system may be unstable" error. Use `forceSetActiveVersion()` to reconcile the marker during recovery.
- A failed step leaves the in-memory marker where it was; `setActiveVersion()` writes the external store before the in-memory marker.
- Hook outcomes are derived, never reported: a `wrapStep` / `wrapRun` hook that skips `run()`, does not await it, calls it twice or swallows its failure cannot produce a success (`#wrap`).

### Special Operations

- `uninstall()` → downgrades past initial, sets version to undefined. Refused upfront if any version on the path (including the initial one) is irreversible.
- `plan(operation, target?)` → dry-run for "up" / "down" / "uninstall"; returns ordered steps (each with `reversible`) without executing
- `removeVersion(version)` → drops a version from the registry (never the active one); what an undo/redo history uses to discard its redo tail
- `status()` → snapshot of active/latest/pending
- `forceSetActiveVersion(version)` → write marker without registry validation (recovery)

## Database Helpers

|                      | `createPgMigrate(pool, options?)` (`./pg`)                                       | `createSqliteMigrate(db, options?)` (`./sqlite`)         |
| -------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Takes                | `pg.Pool`-shaped (`connect()`, `query()`)                                        | a `node:sqlite` `DatabaseSync`, nothing else             |
| Worker context       | `{ client, ...options.context }`                                                 | `{ db, ...options.context }`                             |
| Run lock (`wrapRun`) | session advisory lock on one checked-out client, polled; keyed by table + schema | `BEGIN IMMEDIATE` for the whole run                      |
| Step (`wrapStep`)    | `begin` / `commit` on that client; `COMMIT` answer checked                       | `SAVEPOINT`; on failure `ROLLBACK TO`                    |
| A step fails         | rolled back; earlier steps were committed                                        | rolled back to savepoint; run then commits earlier steps |
| Broken state         | connection destroyed (`release(error)`)                                          | whole run rolled back                                    |

- Options of both: `table` (default `__migrate__`, validated `[A-Za-z_][A-Za-z0-9_]*` because it is
  interpolated into SQL), `context`, `logger`
- Version table is insert-only (`id`, `version`, `created_at`): newest row = active version
- A read outside a run never creates the table; a write outside a run locks on its own
- Both return a plain `Migrate`; they only supply `getActiveVersion`, `setActiveVersion`,
  `wrapRun`, `wrapStep`

## File Structure

```
src/
  mod.ts          # Main exports, module documentation
  migrate.ts      # Migrate and Version classes
  pg.ts           # createPgMigrate: subpath "./pg" (not re-exported from mod.ts)
  sqlite.ts       # createSqliteMigrate: subpath "./sqlite" (not re-exported from mod.ts)

# Semver utilities (normalizeSemver, parseSemver, compareSemver) live in the
# standalone @marianmeres/semver package and are re-exported from mod.ts (DRY).

tests/            # node:test + node:assert/strict; import ../src, never dist
  migrate.test.ts # Migration tests (28 tests)
  semver.test.ts  # Smoke test of the re-exported semver surface (4 tests)
  example.test.ts # The README's undo / redo example, as assertions (1 test)
  pg.test.ts      # Postgres helper: 4 tests on a recording fake pool (always run), 5 on a
                  # real server (DB_* env; skipped without it, failing without it in CI)
  sqlite.test.ts  # SQLite helper on node:sqlite (6 tests; the 2 on a database file are
                  # skipped where the runtime gives no temp directory)
  fixtures/sqlite-run.ts # child process of the cross-process SQLite test

example/          # Node + pg; run with `node --env-file=.env example/db-migrate.ts ...`
  db-migrate.ts   # PostgreSQL CLI example on createPgMigrate (node:util parseArgs, node:fs
                  # walk); its loader throws on a version it cannot load, never skips one
  _db.ts          # pg Pool from DB_* env (see .env.example) and the Context type
  1.0.0/migrate.ts
  1.1.0/migrate.ts
  2.0.0/migrate.ts

package.json        # manifest of record: version, npm exports, dependencies, scripts
jsr.json            # JSR manifest: exports, jsr: import map, publish.include (no version)
tsconfig.json       # type gate: src + tests + example, noEmit
tsconfig.build.json # src -> dist (ESM + .d.ts) for npm
biome.json          # format + lint (recommended, two test-only rules warn-listed)
```

## Public API Summary

### Exports from `mod.ts`

```typescript
// Classes
export class Migrate<TContext = any>
export class Version<TContext = any>

// Types
export interface MigrateOptions<TContext = any>
export type MigrateFn<TContext = any>  // (context: TContext) => unknown
export interface Plan
export interface PlanStep              // { version, activeAfter, reversible }
export interface Status
export interface StepInfo              // PlanStep + direction; given to wrapStep
export interface RunInfo               // { operation, target }; given to wrapRun

// Semver utilities — re-exported from @marianmeres/semver (overloaded)
export interface ParsedSemver
export function normalizeSemver(version: string, assert?: true): string
export function normalizeSemver(version: string, assert: false): string | undefined
export function parseSemver(version: string): ParsedSemver
export function compareSemver(a: string, b: string): number
```

### Exports from `pg.ts` (`@marianmeres/migrate/pg`)

```typescript
export function createPgMigrate(pool, options?): Migrate<TExtra & PgMigrateContext<...>>
export interface PgMigrateOptions<TExtra>   // { table?, context?, logger? }
export interface PgMigrateContext<TClient>  // { client }
export interface PgPoolLike                 // { connect(), query() }
export interface PgClientLike               // { query(), release() }
export interface PgQueryResultLike          // { rows, command? }
export type PgClientOf<TPool>               // pg.PoolClient for pg.Pool
export const PG_MIGRATE_TABLE               // "__migrate__"
```

### Exports from `sqlite.ts` (`@marianmeres/migrate/sqlite`)

```typescript
export function createSqliteMigrate(db: DatabaseSync, options?): Migrate<TExtra & SqliteMigrateContext>
export interface SqliteMigrateOptions<TExtra> // { table?, context?, logger? }
export interface SqliteMigrateContext         // { db: DatabaseSync }
export const SQLITE_MIGRATE_TABLE             // "__migrate__"
```

### Migrate Class Methods

| Method                  | Signature                        | Returns                        | Description                                                |
| ----------------------- | -------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| `addVersion`            | `(version, up, down?, comment?)` | `Version`                      | Register version (`down=null` → irreversible)              |
| `removeVersion`         | `(version)`                      | `Promise<boolean>`             | Unregister version (serialized; throws for the active one) |
| `getActiveVersion`      | `()`                             | `Promise<string \| undefined>` | Get current (syncs internal from external when configured) |
| `setActiveVersion`      | `(version)`                      | `Promise<string \| undefined>` | Set current (validates against registry)                   |
| `forceSetActiveVersion` | `(version)`                      | `Promise<string \| undefined>` | Write marker without registry validation (recovery)        |
| `up`                    | `(target?)`                      | `Promise<number>`              | Upgrade (serialized)                                       |
| `down`                  | `(target?)`                      | `Promise<number>`              | Downgrade (serialized)                                     |
| `uninstall`             | `()`                             | `Promise<number>`              | Remove all (serialized)                                    |
| `plan`                  | `(operation, target?)`           | `Promise<Plan>`                | Dry-run of up/down/uninstall: exactly what would execute   |
| `status`                | `()`                             | `Promise<Status>`              | Snapshot: active/latest/pending                            |
| `indexOf`               | `(version)`                      | `number`                       | Find index                                                 |
| `findVersion`           | `(version, assert?)`             | `Version \| undefined`         | Find instance                                              |

### Migrate Class Properties

| Property    | Type        | Description             |
| ----------- | ----------- | ----------------------- |
| `versions`  | `Version[]` | All registered versions |
| `available` | `string[]`  | Version strings         |
| `context`   | `TContext`  | Migration context       |
| `compareFn` | `function`  | Sort comparator         |

### Constructor Options (`MigrateOptions<TContext>`)

| Option             | Signature                                                  | Description                                                    |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------------- |
| `getActiveVersion` | `(context) => string \| null \| undefined` (sync or async) | Marker reader; with `setActiveVersion` or not at all           |
| `setActiveVersion` | `(version, context) => unknown`                            | Marker writer; with `getActiveVersion` or not at all           |
| `wrapStep`         | `(run, step: StepInfo, context) => unknown`                | Wraps worker + marker write of one step (a transaction)        |
| `wrapRun`          | `(run, info: RunInfo, context) => unknown`                 | Wraps a whole up/down/uninstall, marker read included (a lock) |
| `logger`           | `(...args) => void`                                        | Debug logger                                                   |

### Version Class Properties

| Property       | Type                  | Description                                   |
| -------------- | --------------------- | --------------------------------------------- |
| `version`      | `string`              | Normalized version                            |
| `major`        | `number`              | Major segment                                 |
| `minor`        | `number`              | Minor segment                                 |
| `patch`        | `number`              | Patch segment                                 |
| `prerelease`   | `string`              | Prerelease label                              |
| `build`        | `string`              | Build metadata                                |
| `comment`      | `string \| undefined` | Description                                   |
| `isReversible` | `boolean`             | `false` if registered without a `down` worker |

## Dependencies

```yaml
runtime:
    - "@marianmeres/item-collection" # Collection management
    - "@marianmeres/semver" # Semver parse/normalize/compare utilities

# npm: package.json "dependencies"; JSR consumers resolve both through jsr.json's
# imports to jsr:@marianmeres/*, so a Deno graph holds one copy of each

dev_only:
    - "typescript" # typecheck and the dist/ build
    - "@biomejs/biome" # format and lint
    - "@types/node" # Node types for tests and the example
    - "pg" # PostgreSQL (example, tests/pg.test.ts)
    - "@types/pg" # pg types (example, tests)

# Neither helper has a runtime import of a database library, so neither adds a dependency:
# - src/pg.ts takes the caller's pool through structural types (PgPoolLike). Keep it that
#   way: importing "pg" would make it a dependency of every consumer.
# - src/sqlite.ts is for node:sqlite ONLY and takes its DatabaseSync, through
#   `import type` (built into Node, erased on emit). Do not widen it to a structural
#   type or to another SQLite library.
```

## Common Patterns

### Database Migration (PostgreSQL, SQLite)

```typescript
import { createPgMigrate } from "@marianmeres/migrate/pg";

// version table, one connection per run, lock across processes, transaction per step
const migrate = createPgMigrate(pool); // a pg.Pool; options: { table, context, logger }

migrate.addVersion(
	"1.0.0",
	({ client }) => client.query("CREATE TABLE users (...)"), // client: pg.PoolClient
	({ client }) => client.query("DROP TABLE users"),
);

await migrate.up("latest");
```

```typescript
import { createSqliteMigrate } from "@marianmeres/migrate/sqlite";

// version table, one BEGIN IMMEDIATE transaction per run, savepoint per step
const migrate = createSqliteMigrate(db); // a node:sqlite DatabaseSync, nothing else

migrate.addVersion(
	"1.0.0",
	({ db }) => db.exec("CREATE TABLE users (...)"),
	({ db }) => db.exec("DROP TABLE users"),
);

await migrate.up("latest");
```

Runnable CLI on the Postgres helper: example/db-migrate.ts.

### Any Other Store (the options the helpers are built on)

```typescript
import { Migrate } from "@marianmeres/migrate";

// `db` is one connection for the whole run; its type flows into every `ctx` below
const migrate = new Migrate({
	getActiveVersion: async (ctx) => {
		const result = await ctx.db.query(
			"SELECT version FROM __migrate__ ORDER BY id DESC LIMIT 1",
		);
		return result.rows[0]?.version;
	},
	setActiveVersion: async (version, ctx) => {
		await ctx.db.query("INSERT INTO __migrate__ (version) VALUES ($1)", [version]);
	},
	// lock: one run at a time across processes
	wrapRun: async (run, _info, ctx) => {
		await ctx.db.query("SELECT pg_advisory_lock(42)");
		try {
			await run();
		} finally {
			await ctx.db.query("SELECT pg_advisory_unlock(42)");
		}
	},
	// transaction: the worker and the marker write commit together
	wrapStep: async (run, _step, ctx) => {
		await ctx.db.query("BEGIN");
		try {
			await run();
			await ctx.db.query("COMMIT");
		} catch (e) {
			await ctx.db.query("ROLLBACK");
			throw e;
		}
	},
}, { db });

migrate.addVersion("1.0.0", async (ctx) => {
	await ctx.db.query("CREATE TABLE users (...)");
}, async (ctx) => {
	await ctx.db.query("DROP TABLE users");
});

await migrate.up("latest");
```

### Undo / Redo (Progress Tracking)

Every action is the next major version; `down()` (default `"major"`) undoes one,
`up("major")` redoes one. An empty version 0 as the start lets the first action be undone.

```typescript
const history = new Migrate();
let sequence = 0;
await history.setActiveVersion(history.addVersion("0", () => {}, () => {}));

const act = async (up: () => unknown, down: () => unknown) => {
	// a new action discards the undone steps (the redo tail)
	for (const v of (await history.status()).pending) await history.removeVersion(v);
	history.addVersion(`${++sequence}`, up, down);
	await history.up(); // applies just the new version
};

await act(() => doStep1(), () => undoStep1());
await act(() => doStep2(), () => undoStep2());

await history.down(); // undo one (returns 0 at version 0)
await history.up("major"); // redo one (returns 0 when nothing is left to redo)
await history.down("initial"); // undo all
```

Keep `tests/example.test.ts` in step with the README's example.

## Error Conditions

| Condition                            | Error Message Pattern                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Duplicate version                    | `"Version already exists"`                                                                                      |
| Version not found                    | `"Version not found"`                                                                                           |
| Target not found                     | `"Unable to find matching"`                                                                                     |
| Downgrade from undefined             | `"Cannot downgrade from undefined"`                                                                             |
| Up worker failure                    | `"The upgrade to version ... failed"` (+ `cause`)                                                               |
| Down worker failure                  | `"The downgrade from version ... failed"` (+ `cause`)                                                           |
| Save failure                         | `"unable to save the ... version"` (+ `cause`)                                                                  |
| Irreversible version on path         | `"Unable to downgrade from ...: version ... is irreversible (no down worker registered). Nothing was changed."` |
| Remove the active version            | `"Cannot remove the active version"`                                                                            |
| Reader without writer (or v.v.)      | `TypeError: ... must be provided together`                                                                      |
| Hook skipped / did not await `run()` | `"hook returned without calling and awaiting run()"`                                                            |
| Hook called `run()` twice            | `"hook must call run() exactly once"`                                                                           |
| Hook threw (not from `run()`)        | `"The \"wrapStep\" hook failed for ..."` / `"The \"wrapStep\" hook failed after ... completed"` (+ `cause`)     |
| Invalid semver input                 | `TypeError: Invalid version "..."`                                                                              |

## Commands

```yaml
install: "pnpm install"
test: "pnpm test" # node --test, reading .env when present (DB_* -> the Postgres server tests run); watch: pnpm run test:watch
test_deno: "pnpm run test:deno" # same suite on Deno, resolved as JSR consumers see it
typecheck: "pnpm run typecheck" # tsc --noEmit: Node strips types and never checks them
lint: "pnpm run lint" # format with: pnpm run format
ci: "pnpm run ci" # typecheck + lint + test, what CI runs
build: "pnpm run build" # tsc -p tsconfig.build.json -> dist/
jsr_dry_run: "pnpm run jsr:check"
release_and_publish: "pnpm run rp" # minor: pnpm run rpm; publishes to npm and JSR
```

## Tooling Conventions

- Node runs the `.ts` source directly (type stripping) and never type-checks it:
  `pnpm run typecheck` is the type gate
- Erasable-only TS: no `enum`, `namespace` or constructor parameter properties; `import type`
  for types; `.ts` extensions in relative imports
- Context generics default to `any`, not `Record<string, any>`: the classes are invariant in
  `TContext`, so only `Migrate<any>` accepts an instance of every context
- `Version.comment` and `Migrate.context` are declared fields assigned first in their
  constructors, kept first in their classes so the emitted `dist/` matches earlier releases
- No `Deno.*` / `Bun.*` APIs and no `jsr:` / `npm:` specifiers in `src/`, `tests/` or `example/`
- `src/` has no runtime `node:*` import either. The one `node:*` specifier is the
  `import type` of `DatabaseSync` in `src/sqlite.ts`: SQLite support is `node:sqlite` only
- Postgres server tests isolate by a random table-name prefix (`mt_<hex>_`), never by a
  schema: an application's database user may create tables but not schemas
- A new subpath entry point goes into both manifests: `exports` in `package.json` (dist
  paths) and in `jsr.json` (src paths)
- `noUncheckedIndexedAccess` is off: the move off Deno changed no logic
- Never run a script named `publish` (npm lifecycle hook); publishing is `publish:all` /
  `publish:jsr`, via `rp` / `rpm`

## Code Style

- Biome: tabs, 4 wide, 90 columns, double quotes; manifests (`package.json`, `jsr.json`)
  at 2 spaces
- TypeScript with strict settings
- Private fields use `#` prefix
- JSDoc on all public APIs
