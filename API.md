# API Reference

This document provides a complete reference for the `@marianmeres/migrate` package.

## Table of Contents

- [Types](#types)
  - [MigrateOptions](#migrateoptions)
  - [MigrateFn](#migratefn)
  - [StepInfo / RunInfo](#stepinfo--runinfo)
  - [Plan / PlanStep](#plan--planstep)
  - [Status](#status)
- [Classes](#classes)
  - [Migrate](#migrate)
  - [Version](#version)
- [Database helpers](#database-helpers)
  - [createPgMigrate](#createpgmigrate)
  - [createSqliteMigrate](#createsqlitemigrate)
- [Semver Utilities](#semver-utilities)
  - [normalizeSemver](#normalizesemver)
  - [parseSemver](#parsesemver)
  - [compareSemver](#comparesemver)
  - [ParsedSemver](#parsedsemver)

---

## Types

`TContext` below is the type of the context object given to the `Migrate` constructor. It is
inferred from that argument, and defaults to `any`.

### MigrateOptions

Configuration options for the `Migrate` class constructor. All are optional.

```typescript
interface MigrateOptions<TContext = any> {
	getActiveVersion?: (
		context: TContext,
	) => string | null | undefined | Promise<string | null | undefined>;
	setActiveVersion?: (version: string | undefined, context: TContext) => unknown;
	wrapStep?: (run: () => Promise<void>, step: StepInfo, context: TContext) => unknown;
	wrapRun?: (run: () => Promise<void>, info: RunInfo, context: TContext) => unknown;
	logger?: (...args: unknown[]) => void;
}
```

| Property           | Description                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getActiveVersion` | Reader of the current active version (e.g., from a database), sync or async. `undefined`, `null` and `""` all mean "nothing is installed". When set, the framework calls it on every `getActiveVersion()` and syncs the in-memory active item to match. |
| `setActiveVersion` | Writer of the current active version. A returned promise is awaited; the value is ignored.                                                                                                                                                              |
| `wrapStep`         | Wraps every single step. See [Hooks](#hooks).                                                                                                                                                                                                           |
| `wrapRun`          | Wraps every `up()` / `down()` / `uninstall()` call. See [Hooks](#hooks).                                                                                                                                                                                |
| `logger`           | Optional debug logger function. Receives timestamped log messages.                                                                                                                                                                                      |

`getActiveVersion` and `setActiveVersion` come together: with neither, the active version
is kept in memory only; with just one of them the constructor throws a `TypeError`.

#### Hooks

Both hooks receive a `run` callback, which they must call and await exactly once, and the
context.

- **`wrapStep(run, step, context)`**: `run()` executes one version's worker and then writes
  the active version. Wrap it in a transaction (begin, `await run()`, commit; roll back and
  rethrow when it throws) and the two are atomic. `step` is a [`StepInfo`](#stepinfo--runinfo).
- **`wrapRun(run, info, context)`**: `run()` executes a whole `up()` / `down()` /
  `uninstall()`, the read of the active version it starts from included. Wrap it in a lock
  and two processes cannot migrate the same system at once. `info` is a
  [`RunInfo`](#stepinfo--runinfo).

```typescript
const migrate = new Migrate(
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
	{ client },
);
```

What happened is tracked by the framework and never taken from the hook's word:

| The hook...                                    | Result                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| returns without having awaited `run()`         | Error: `The "wrapStep" hook returned without calling and awaiting run() ...`                     |
| calls `run()` a second time                    | Error: `The "wrapStep" hook must call run() exactly once`                                        |
| catches the failure of `run()` and returns     | The failure of `run()` is thrown anyway                                                          |
| throws while handling a failed `run()`         | The failure of `run()` is thrown (not the hook's own error)                                      |
| throws after `run()` succeeded (failed commit) | The step counts as failed; the in-memory active version is restored; the hook's error is `cause` |

### MigrateFn

The worker type used for migration up/down operations. A returned promise is awaited; any
other returned value is ignored.

```typescript
type MigrateFn<TContext = any> = (context: TContext) => unknown;
```

### StepInfo / RunInfo

What the [hooks](#hooks) receive.

```typescript
interface StepInfo extends PlanStep {
	direction: "up" | "down"; // which worker of `version` the step runs
}

interface RunInfo {
	operation: "up" | "down" | "uninstall";
	target: string | undefined; // as given to up() / down(), defaults applied; undefined for uninstall
}
```

### Plan / PlanStep

Return types of [`Migrate.plan()`](#plan).

```typescript
interface PlanStep {
	version: string;                 // the version whose worker runs at this step
	activeAfter: string | undefined; // active version after the step succeeds
	reversible: boolean;             // whether the version has a `down` worker
}

interface Plan {
	direction: "up" | "down";
	fromVersion: string | undefined;
	toVersion: string | undefined;
	steps: PlanStep[];
}
```

A `"down"` plan with a step that is not `reversible` cannot be executed: `down()` and
`uninstall()` refuse it before running anything.

### Status

Return type of [`Migrate.status()`](#status-1).

```typescript
interface Status {
	active: string | undefined;   // current active version
	latest: string | undefined;   // highest registered version
	isAtLatest: boolean;
	pending: string[];            // registered versions strictly above active
}
```

---

## Classes

### Migrate

The main migration manager class that handles version tracking and migration execution.

#### Constructor

```typescript
new Migrate<TContext>(options?: MigrateOptions<TContext>, context?: TContext)
```

| Parameter | Type                       | Description                                                                     |
| --------- | -------------------------- | ------------------------------------------------------------------------------- |
| `options` | `MigrateOptions<TContext>` | Configuration options for version storage, hooks and logging.                   |
| `context` | `TContext`                 | Arbitrary context object passed to each migration function and option callback. |

`TContext` is inferred from `context`, so workers and callbacks are typed without casts:

```typescript
const migrate = new Migrate({}, { db });

migrate.addVersion("1.0.0", (ctx) => ctx.db.query("create table users (...)"));
```

A bare `Migrate` is `Migrate<any>`: the type to use for a variable or parameter that
accepts an instance of any context.

**Throws:** `TypeError` if only one of `getActiveVersion` / `setActiveVersion` is given.

#### Properties

| Property    | Type                                 | Description                                                          |
| ----------- | ------------------------------------ | -------------------------------------------------------------------- |
| `versions`  | `Version<TContext>[]`                | Array of all registered Version instances (read-only).               |
| `available` | `string[]`                           | Array of all available version strings in semver format (read-only). |
| `context`   | `TContext`                           | The context object passed to migrations.                             |
| `compareFn` | `(a: Version, b: Version) => number` | The comparison function used for sorting versions (read-only).       |

#### Methods

##### addVersion

Registers a new version with its migration functions.

```typescript
addVersion(
  version: string,
  up: MigrateFn<TContext>,
  down?: MigrateFn<TContext> | null,
  comment?: string
): Version<TContext>
```

| Parameter | Type                | Description                                                                                                                                                    |
| --------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version` | `string`            | The version string (will be normalized to semver format).                                                                                                      |
| `up`      | `MigrateFn`         | The upgrade function to execute when migrating up to this version.                                                                                             |
| `down`    | `MigrateFn \| null` | The downgrade function. Pass `null` (or omit) to mark the version as **irreversible**: any `down()`/`uninstall()` whose path crosses it is refused as a whole. |
| `comment` | `string`            | Optional comment or description for this version.                                                                                                              |

**Returns:** The created `Version` instance.

**Throws:** `Error` if the version already exists.

**Notes:** Only the active version is stored, not the set of applied ones. A version added
_below_ the active version is never applied and never reported as pending, so number new
versions above the highest one already applied.

##### removeVersion

Removes a version from the registry. Queued behind any running `up()` / `down()` /
`uninstall()`.

```typescript
removeVersion(version: string | Version<TContext>): Promise<boolean>
```

**Returns:** `true` if removed, `false` if no such version is registered.

**Throws:** `Error` if the version is the active one (its marker would be orphaned).

**Example:** an undo/redo history drops the undone steps before recording a new action:

```typescript
for (const undone of (await app.status()).pending) {
	await app.removeVersion(undone);
}
```

##### getActiveVersion

Gets the currently active version.

```typescript
async getActiveVersion(): Promise<string | undefined>
```

**Returns:** The active version string, or `undefined` if not set.

**Notes:** When an external `getActiveVersion` option is configured, it is treated as the source of truth — every call reads through it and the in-memory active item is synced to match. Useful on cold-start where the registry has versions defined in code but no active item yet.

##### setActiveVersion

Sets the currently active version.

```typescript
async setActiveVersion(
  version: "latest" | "initial" | undefined | string | Version
): Promise<string | undefined>
```

| Parameter | Type                                                      | Description                                                                                                                                                        |
| --------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version` | `"latest" \| "initial" \| undefined \| string \| Version` | The version to set as active. Use `"latest"` for highest version, `"initial"` for first version, `undefined` to mark as uninstalled, or a specific version string. |

**Returns:** The newly set active version string, or `undefined`.

**Throws:** `Error` if the specified version does not exist.

**Notes:** The external `setActiveVersion` option (if configured) is written first. When it throws, the in-memory active version is left where it was.

##### forceSetActiveVersion

Writes the active version marker without validating that the version exists in the registered set. Intended for recovery after a partial failure (migration succeeded but the marker write failed, or the marker was left pointing at an unexpected value).

```typescript
async forceSetActiveVersion(
  version: string | undefined
): Promise<string | undefined>
```

| Parameter | Type                  | Description                                                                                                                                                        |
| --------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version` | `string \| undefined` | Normalized semver string, or `undefined` to clear the marker. Unknown versions clear the in-memory active item but are still written to external storage verbatim. |

**Returns:** The normalized version written, or `undefined`.

##### up

Executes migration upgrades to the specified target version.

```typescript
async up(
  target?: "latest" | "major" | "minor" | "patch" | string
): Promise<number>
```

| Parameter | Type     | Default    | Description                             |
| --------- | -------- | ---------- | --------------------------------------- |
| `target`  | `string` | `"latest"` | The target version or semver increment. |

**Target options:**

- `"latest"` - Upgrade to the highest available version
- `"major"` - Upgrade to highest version of the next major
- `"minor"` - Upgrade to the highest version still within the current major
- `"patch"` - Upgrade to the highest version still within the current major + minor
- Specific version string (e.g., `"2.0.0"`)

Semver increments use actual semver ordering (via `compareSemver`), so `up("patch")` at `1.0.0-alpha` correctly reaches `1.0.0` / `1.0.x`, and `up("minor")` at `1.0.0-alpha` reaches `1.x.y`.

**Returns:** The number of migration steps executed.

**Throws:** `Error` if the target version is not found or if a migration fails. The error of a failed worker (or of a failed write of the active version) carries the original error as its `cause`.

**Concurrency:** Calls to `up()`, `down()` and `uninstall()` on the same `Migrate` instance are automatically serialized — a second call won't start until the first has settled. Across processes, use the [`wrapRun`](#hooks) hook.

##### down

Executes migration downgrades to the specified target version.

```typescript
async down(
  target?: "initial" | "major" | "minor" | "patch" | string
): Promise<number>
```

| Parameter | Type     | Default   | Description                             |
| --------- | -------- | --------- | --------------------------------------- |
| `target`  | `string` | `"major"` | The target version or semver decrement. |

**Target options:**

- `"initial"` - Downgrade to the first version (keeps initial version)
- `"major"` - Downgrade to the highest version strictly below in the previous major
- `"minor"` - Downgrade to the highest version strictly below in the current major
- `"patch"` - Downgrade to the highest version strictly below in the current major + minor
- Specific version string (e.g., `"1.0.0"`)

**Returns:** The number of migration steps executed.

**Throws:** `Error` if there is no active version, target is not found, or if a migration fails. A path that crosses an [irreversible](#addversion) version is refused **before any step runs**: nothing is rolled back, and the active version does not move.

##### uninstall

Performs a complete uninstall by downgrading past the initial version.

```typescript
async uninstall(): Promise<number>
```

**Returns:** The number of migration steps executed (`0` when nothing is installed).

**Throws:** `Error` if the uninstall operation fails. When any version on the path (the initial one included) was registered without a `down` worker, the uninstall is refused before any step runs.

##### plan

Computes the steps `up`, `down` or `uninstall` would execute **without running any migration functions or mutating state**. The three execute exactly what `plan` returns. Useful for dry-runs, previews, and tests.

```typescript
async plan(
  operation: "up" | "down" | "uninstall",
  target?: string
): Promise<Plan>
```

| Parameter   | Type                            | Description                                                                                                            |
| ----------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `operation` | `"up" \| "down" \| "uninstall"` | Which plan to compute.                                                                                                 |
| `target`    | `string`                        | Same target vocabulary as `up` / `down`. Defaults to `"latest"` for up, `"major"` for down. Ignored for `"uninstall"`. |

**Returns:** A [`Plan`](#plan--planstep) object with resolved `fromVersion`, `toVersion`, and an ordered list of `steps`. An uninstall is a `"down"` plan with `toVersion: undefined`, whose last step has `activeAfter: undefined`.

**Throws:** `Error` if the target cannot be resolved (or, for `"down"`, if there is no active version).

**Example:** check a rollback before attempting it:

```typescript
const plan = await migrate.plan("down", "1.0.0");
const blockedBy = plan.steps.filter((s) => !s.reversible).map((s) => s.version);
```

##### status

Produces a status snapshot.

```typescript
async status(): Promise<Status>
```

**Returns:** A [`Status`](#status) object with the current active version, the highest registered version, an `isAtLatest` boolean, and the list of registered versions strictly above the current active by semver order (also when the active version itself is not registered).

##### indexOf

Returns the index of a version in the internal collection.

```typescript
indexOf(version: string): number
```

**Returns:** The index of the version, or `-1` if not found.

##### findVersion

Finds a version instance by version string.

```typescript
findVersion(version: string, assert?: boolean): Version | undefined
```

| Parameter | Type      | Default | Description                                         |
| --------- | --------- | ------- | --------------------------------------------------- |
| `version` | `string`  | -       | The version string to find.                         |
| `assert`  | `boolean` | `false` | If true, throws an error when version is not found. |

**Returns:** The `Version` instance, or `undefined` if not found.

**Throws:** `Error` if assert is true and version is not found.

---

### Version

Represents a single version with its migration functions.

#### Constructor

```typescript
new Version<TContext>(
  version: string,
  up: MigrateFn<TContext>,
  down?: MigrateFn<TContext> | null,
  comment?: string,
  logger?: (...args: unknown[]) => void
)
```

| Parameter | Type                | Description                                                                         |
| --------- | ------------------- | ----------------------------------------------------------------------------------- |
| `version` | `string`            | The version string (will be normalized to semver format).                           |
| `up`      | `MigrateFn`         | The upgrade function.                                                               |
| `down`    | `MigrateFn \| null` | The downgrade function. `null`/omitted marks the version as irreversible (one-way). |
| `comment` | `string`            | Optional comment or description.                                                    |
| `logger`  | `function`          | Optional logger function.                                                           |

#### Properties

| Property       | Type                  | Description                                                      |
| -------------- | --------------------- | ---------------------------------------------------------------- |
| `version`      | `string`              | The normalized semver version string (read-only).                |
| `major`        | `number`              | The major version segment (read-only).                           |
| `minor`        | `number`              | The minor version segment (read-only).                           |
| `patch`        | `number`              | The patch version segment (read-only).                           |
| `prerelease`   | `string`              | The prerelease segment, e.g., `"alpha"`, `"beta.1"` (read-only). |
| `build`        | `string`              | The build metadata segment (read-only).                          |
| `comment`      | `string \| undefined` | Optional description (read-only).                                |
| `isReversible` | `boolean`             | `false` if the version was registered without a `down` worker.   |

#### Methods

##### up

Executes the upgrade migration function and returns whatever it returned.

```typescript
up(context: TContext): unknown
```

##### down

Executes the downgrade migration function and returns whatever it returned. Throws if the version is irreversible.

```typescript
down(context: TContext): unknown
```

##### toString

Returns the normalized version string.

```typescript
toString(): string
```

---

## Database helpers

Two subpath entry points wire a `Migrate` instance to a database. Each returns an ordinary
[`Migrate`](#migrate): register versions with `addVersion()`, then use `up()`, `down()`,
`uninstall()`, `plan()` and `status()` as usual. Neither adds a dependency: you pass in
your own `pg` pool or `node:sqlite` database.

What both do:

- **A version table.** The active version is the newest row of an insert-only table
  (`__migrate__` unless `table` says otherwise) with the columns `id`, `version` and
  `created_at`; the older rows are the history. The first run or write creates it. A read
  (`status()`, `getActiveVersion()`, `plan()`) never does.
- **One run at a time, across processes.** A second run waits for the first, then reads
  the version the first left behind and finds nothing to do.
- **Atomic steps.** A version's worker and the write of the active version are kept
  together or undone together. When a step fails, the steps the same run completed before
  it stay.

A worker must not issue transaction control statements (`begin`, `commit`, `rollback`)
itself: it runs inside the step's transaction.

### createPgMigrate

```typescript
import { createPgMigrate } from "@marianmeres/migrate/pg";

function createPgMigrate<TPool extends PgPoolLike, TExtra = {}>(
	pool: TPool,
	options?: PgMigrateOptions<TExtra>,
): Migrate<TExtra & PgMigrateContext<PgClientOf<TPool>>>;
```

| Parameter         | Description                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pool`            | A `pg.Pool` (node-postgres), or anything shaped like one: `query()`, and `connect()` resolving to a client with `query()` and `release()`. The caller keeps owning it; the helper never ends it. |
| `options.table`   | Name of the version table. Letters, digits and underscores only. Default: `"__migrate__"`.                                                                                                       |
| `options.context` | Extra properties for the context every worker receives, next to `client`.                                                                                                                        |
| `options.logger`  | Optional debug logger.                                                                                                                                                                           |

**Returns:** A `Migrate` whose workers receive `{ client, ...context }`. `client` has the
pool's own client type (`pg.PoolClient` for a `pg.Pool`).

**Throws:** `TypeError` for an invalid table name.

```typescript
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const migrate = createPgMigrate(pool, { table: "__migrate__" });

migrate.addVersion(
	"1.0.0",
	({ client }) => client.query("create table users (id serial primary key)"),
	({ client }) => client.query("drop table users"),
);

await migrate.up();
```

**A run, step by step:**

1. One client is checked out of the pool. Everything the run does happens on it, and
   workers receive it as `client`.
2. It takes a session advisory lock, keyed by the table name and the current schema. The
   lock is polled (`pg_try_advisory_lock`), not waited for inside a statement.
3. The table is created if missing, and the active version is read.
4. Every step is `begin`, the worker, the insert of the new version row, `commit`. Any
   failure rolls the step back. A `commit` that the server answers with `ROLLBACK` counts
   as a failure.
5. The lock is released and the client goes back to the pool. A connection left in an
   unknown state (a failed `rollback` or unlock) is destroyed instead, which also releases
   its lock.

**Limits:**

- Statements that cannot run inside a transaction (`create index concurrently`) cannot be
  issued by a worker. For those, use the core `Migrate` with your own
  [`wrapStep`](#hooks).
- Connect directly, not through a pooler in transaction mode: the lock belongs to the
  session.
- `setActiveVersion()` and `forceSetActiveVersion()` called outside a run take the lock
  and write on a connection of their own.

A version table created by the 1.x example (`id serial`, `version varchar(255)`,
`created_at`) is used as it is.

**Types:**

```typescript
interface PgMigrateOptions<TExtra = {}> {
	table?: string;
	context?: TExtra;
	logger?: (...args: unknown[]) => void;
}

interface PgMigrateContext<TClient = PgClientLike> {
	client: TClient; // the run's one connection, inside the step's transaction
}

// what the helper needs of a pool and of a client
interface PgPoolLike {
	connect(): Promise<PgClientLike>;
	query(text: string, values?: any[]): Promise<PgQueryResultLike>;
}
interface PgClientLike {
	query(text: string, values?: any[]): Promise<PgQueryResultLike>;
	release(destroy?: Error | boolean): void;
}
interface PgQueryResultLike {
	rows: any[];
	command?: string;
}

type PgClientOf<TPool>; // the client type TPool's connect() resolves to
const PG_MIGRATE_TABLE = "__migrate__";
```

### createSqliteMigrate

```typescript
import { createSqliteMigrate } from "@marianmeres/migrate/sqlite";

function createSqliteMigrate<TExtra = {}>(
	db: DatabaseSync, // from "node:sqlite"
	options?: SqliteMigrateOptions<TExtra>,
): Migrate<TExtra & SqliteMigrateContext>;
```

| Parameter         | Description                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `db`              | A `DatabaseSync` of `node:sqlite`, the SQLite module built into Node. The caller keeps owning it, and closes it. |
| `options.table`   | Name of the version table. Letters, digits and underscores only. Default: `"__migrate__"`.                       |
| `options.context` | Extra properties for the context every worker receives, next to `db`.                                            |
| `options.logger`  | Optional debug logger.                                                                                           |

**Returns:** A `Migrate` whose workers receive `{ db, ...context }`.

**Throws:** `TypeError` for an invalid table name.

```typescript
import { DatabaseSync } from "node:sqlite";

// the busy timeout is how long this connection waits for another one's run
const db = new DatabaseSync("app.db", { timeout: 5000 });
const migrate = createSqliteMigrate(db);

migrate.addVersion(
	"1.0.0",
	({ db }) => db.exec("create table users (id integer primary key)"),
	({ db }) => db.exec("drop table users"),
);

await migrate.up();
```

**A run, step by step:**

1. `BEGIN IMMEDIATE` takes SQLite's write lock at once. Another connection's run waits for
   it as long as that connection's busy timeout allows; with no timeout it fails with
   "database is locked".
2. The table is created if missing, and the active version is read, both under the lock.
3. Every step is a savepoint: the worker, then the insert of the new version row. A
   failure rolls back to the savepoint.
4. `COMMIT`, also when a step failed: the failed step is already undone, and the steps
   before it are kept.

**Limits:**

- The whole run is one transaction, so a process that dies mid-run loses every step of
  that run (the database stays consistent, and the next run starts over).
- Statements that have no effect inside a transaction (`PRAGMA foreign_keys`) or cannot
  run in one (`VACUUM`) cannot be issued by a worker.
- Nothing else should write through the same `DatabaseSync` while a run is in progress: it
  would become part of the run's transaction.
- `node:sqlite` is the only SQLite library supported. Its types are part of the helper's
  signature, so a TypeScript project needs `@types/node`.

**Types:**

```typescript
interface SqliteMigrateOptions<TExtra = {}> {
	table?: string;
	context?: TExtra;
	logger?: (...args: unknown[]) => void;
}

interface SqliteMigrateContext {
	db: DatabaseSync; // with the run's transaction open on it
}

const SQLITE_MIGRATE_TABLE = "__migrate__";
```

---

## Semver Utilities

These utilities are provided by the standalone [`@marianmeres/semver`](https://jsr.io/@marianmeres/semver) package and re-exported here for convenience, so they can be imported directly from `@marianmeres/migrate`. The `ParsedSemver` type is re-exported as well.

### normalizeSemver

Normalizes a version string to comply with semver format (MAJOR.MINOR.PATCH). Prerelease and build identifiers must only contain semver-spec characters (`[0-9A-Za-z-.]`).

```typescript
function normalizeSemver(version: string, assert?: true): string;
function normalizeSemver(version: string, assert: false): string | undefined;
```

| Parameter | Type      | Default | Description                                                                                 |
| --------- | --------- | ------- | ------------------------------------------------------------------------------------------- |
| `version` | `string`  | -       | The version string to normalize.                                                            |
| `assert`  | `boolean` | `true`  | If `true` (default), throws `TypeError` for invalid input. If `false`, returns `undefined`. |

**Returns:** The normalized semver string (or `undefined` when `assert` is `false` and the input is invalid).

**Examples:**

```typescript
normalizeSemver("v1.2"); // "1.2.0"
normalizeSemver("7"); // "7.0.0"
normalizeSemver("7-rc.1"); // "7.0.0-rc.1"
normalizeSemver("1.2.3-alpha+build"); // "1.2.3-alpha+build"
normalizeSemver("banana", false); // undefined
normalizeSemver("1.0.0-foo_bar"); // throws (underscore is not a valid semver char)
```

### parseSemver

Parses a semver string into its component parts.

```typescript
function parseSemver(version: string): ParsedSemver;
```

**Returns:** A [`ParsedSemver`](#parsedsemver) object containing the parsed version components.

**Example:**

```typescript
parseSemver("1.2.3-alpha+build");
// { major: 1, minor: 2, patch: 3, prerelease: "alpha", build: "build" }
```

### compareSemver

Compares two semver strings according to semver precedence rules.

```typescript
function compareSemver(a: string, b: string): number;
```

**Returns:**

- Negative number if `a < b`
- Positive number if `a > b`
- Zero if equal

**Examples:**

```typescript
compareSemver("1.0.0", "2.0.0"); // negative (1.0.0 < 2.0.0)
compareSemver("2.0.0", "1.0.0"); // positive (2.0.0 > 1.0.0)
compareSemver("1.0.0-alpha", "1.0.0"); // negative (prerelease < release)
```

**Notes:**

- Prerelease versions have lower precedence than normal versions
- Build metadata is ignored for version precedence

### ParsedSemver

The shape returned by [`parseSemver`](#parsesemver).

```typescript
interface ParsedSemver {
	major: number;      // the X in X.y.z
	minor: number;      // the Y in x.Y.z
	patch: number;      // the Z in x.y.Z
	prerelease: string; // prerelease without leading "-" (e.g. "rc.1"), or ""
	build: string;      // build metadata without leading "+" (e.g. "build.123"), or ""
}
```
