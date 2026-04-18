# @marianmeres/migrate - Agent Reference

Machine-readable comprehensive documentation for AI agents and LLMs.

## Package Identity

```yaml
name: "@marianmeres/migrate"
version: "2.0.0"
author: "Marian Meres"
license: "MIT"
repository: "https://github.com/marianmeres/migrate"
npm: "https://www.npmjs.com/package/@marianmeres/migrate"
jsr: "https://jsr.io/@marianmeres/migrate"
runtimes: ["deno", "node"]
```

## Purpose

A general-purpose extensible versioning framework for managing incremental, bi-directional changes.

## Use Cases

- Database migrations (PostgreSQL, MySQL, SQLite, etc.)
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
- Omitting `down` (passing `null`/`undefined`) marks the version as **irreversible** — any `down()`/`uninstall()` that reaches it throws
- Context object passed to all migration functions

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
- `up()` / `down()` / `uninstall()` on the same instance are **serialized** via an internal promise chain — concurrent calls run one at a time.
- Partial failure (migration ran, marker write failed) throws a clear "system may be unstable" error. Use `forceSetActiveVersion()` to reconcile the marker during recovery.

### Special Operations

- `uninstall()` → downgrades past initial, sets version to undefined. Fails if any version on the path (including the initial one) is irreversible.
- `plan(direction, target?)` → dry-run; returns ordered steps without executing
- `status()` → snapshot of active/latest/pending
- `forceSetActiveVersion(version)` → write marker without registry validation (recovery)

## File Structure

```
src/
  mod.ts          # Main exports, module documentation
  migrate.ts      # Migrate and Version classes
  semver.ts       # normalizeSemver, parseSemver, compareSemver

tests/
  migrate.test.ts # Migration tests (14 tests)
  semver.test.ts  # Semver utility tests (4 tests)
  example.test.ts # Progress tracking example (1 test)

example/
  db-migrate.ts   # PostgreSQL CLI example
  _db.ts          # Database helpers
  1.0.0/migrate.ts
  1.1.0/migrate.ts
  2.0.0/migrate.ts
```

## Public API Summary

### Exports from `mod.ts`

```typescript
// Classes
export class Migrate
export class Version

// Types
export interface MigrateOptions
export type MigrateFn
export interface Plan
export interface PlanStep
export interface Status

// Semver utilities (overloaded)
export function normalizeSemver(version: string, assert?: true): string
export function normalizeSemver(version: string, assert: false): string | undefined
export function parseSemver(version: string): ParsedSemver
export function compareSemver(a: string, b: string): number
```

### Migrate Class Methods

| Method                   | Signature                        | Returns                        | Description                                                |
| ------------------------ | -------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| `addVersion`             | `(version, up, down?, comment?)` | `Version`                      | Register version (`down=null` → irreversible)              |
| `getActiveVersion`       | `()`                             | `Promise<string \| undefined>` | Get current (syncs internal from external when configured) |
| `setActiveVersion`       | `(version)`                      | `Promise<string \| undefined>` | Set current (validates against registry)                   |
| `forceSetActiveVersion`  | `(version)`                      | `Promise<string \| undefined>` | Write marker without registry validation (recovery)        |
| `up`                     | `(target?)`                      | `Promise<number>`              | Upgrade (serialized)                                       |
| `down`                   | `(target?)`                      | `Promise<number>`              | Downgrade (serialized)                                     |
| `uninstall`              | `()`                             | `Promise<number>`              | Remove all (serialized)                                    |
| `plan`                   | `(direction, target?)`           | `Promise<Plan>`                | Dry-run: resolved steps without execution                  |
| `status`                 | `()`                             | `Promise<Status>`              | Snapshot: active/latest/pending                            |
| `indexOf`                | `(version)`                      | `number`                       | Find index                                                 |
| `findVersion`            | `(version, assert?)`             | `Version \| undefined`         | Find instance                                              |

### Migrate Class Properties

| Property    | Type                  | Description             |
| ----------- | --------------------- | ----------------------- |
| `versions`  | `Version[]`           | All registered versions |
| `available` | `string[]`            | Version strings         |
| `context`   | `Record<string, any>` | Migration context       |
| `compareFn` | `function`            | Sort comparator         |

### Version Class Properties

| Property       | Type                  | Description                                           |
| -------------- | --------------------- | ----------------------------------------------------- |
| `version`      | `string`              | Normalized version                                    |
| `major`        | `number`              | Major segment                                         |
| `minor`        | `number`              | Minor segment                                         |
| `patch`        | `number`              | Patch segment                                         |
| `prerelease`   | `string`              | Prerelease label                                      |
| `build`        | `string`              | Build metadata                                        |
| `comment`      | `string \| undefined` | Description                                           |
| `isReversible` | `boolean`             | `false` if registered without a `down` worker         |

## Dependencies

```yaml
runtime:
    - "@marianmeres/item-collection" # Collection management

dev_only:
    - "@std/assert" # Testing
    - "@std/cli" # CLI parsing
    - "@std/fs" # File system
    - "@std/path" # Path utilities
    - "pg" # PostgreSQL (example)
    - "dotenv" # Environment (example)
```

## Common Patterns

### Basic Database Migration

```typescript
import { Migrate } from "@marianmeres/migrate";

const migrate = new Migrate({
	getActiveVersion: async (ctx) => {
		const result = await ctx.db.query("SELECT version FROM __migrate__");
		return result.rows[0]?.version;
	},
	setActiveVersion: async (version, ctx) => {
		await ctx.db.query("INSERT INTO __migrate__ (version) VALUES ($1)", [version]);
		return version;
	},
}, { db: databaseConnection });

migrate.addVersion("1.0.0", async (ctx) => {
	await ctx.db.query("CREATE TABLE users (...)");
}, async (ctx) => {
	await ctx.db.query("DROP TABLE users");
});

await migrate.up("latest");
```

### Progress Tracking

```typescript
const app = new Migrate();
let sequence = 1;

const work = async (action: () => void, undo: () => void) => {
	await action();
	const ver = app.addVersion(`${sequence++}`, action, undo);
	await app.setActiveVersion(ver);
};

await work(() => doStep1(), () => undoStep1());
await work(() => doStep2(), () => undoStep2());

await app.down(); // Undo last step
await app.up("latest"); // Redo all
await app.uninstall(); // Remove all
```

## Error Conditions

| Condition                    | Error Message Pattern                           |
| ---------------------------- | ----------------------------------------------- |
| Duplicate version            | `"Version already exists"`                      |
| Version not found            | `"Version not found"`                           |
| Target not found             | `"Unable to find matching"`                     |
| Downgrade from undefined     | `"Cannot downgrade from undefined"`             |
| Migration failure            | `"The upgrade/downgrade to version ... failed"` |
| Save failure                 | `"unable to save the ... version"`              |
| Irreversible version reached | `"is irreversible (no down worker registered)"` |
| Invalid semver input         | `TypeError: Invalid version "..."`              |

## Testing

```bash
deno task test        # Run tests
deno task test:watch  # Watch mode
```

## Build

```bash
deno task npm:build   # Build NPM package
deno task publish     # Publish to JSR and NPM
```

## Code Style

- Deno formatter: tabs, 90 char line width
- TypeScript with strict settings
- Private fields use `#` prefix
- JSDoc on all public APIs
