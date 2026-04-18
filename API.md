# API Reference

This document provides a complete reference for the `@marianmeres/migrate` package.

## Table of Contents

- [Types](#types)
  - [MigrateOptions](#migrateoptions)
  - [MigrateFn](#migratefn)
  - [Plan / PlanStep](#plan--planstep)
  - [Status](#status)
- [Classes](#classes)
  - [Migrate](#migrate)
  - [Version](#version)
- [Semver Utilities](#semver-utilities)
  - [normalizeSemver](#normalizesemver)
  - [parseSemver](#parsesemver)
  - [compareSemver](#comparesemver)

---

## Types

### MigrateOptions

Configuration options for the `Migrate` class constructor.

```typescript
interface MigrateOptions {
	getActiveVersion: (context: Record<string, unknown>) => Promise<string | undefined>;
	setActiveVersion: (
		version: string | undefined,
		context: Record<string, unknown>,
	) => Promise<unknown>;
	logger?: (...args: unknown[]) => void;
}
```

| Property           | Type       | Description                                                                                                                                                 |
| ------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getActiveVersion` | `function` | Async reader for the current active version (e.g., database). If not provided, the version is kept in memory only. When set, the framework calls it on every `getActiveVersion()` and syncs the in-memory active item to match. |
| `setActiveVersion` | `function` | Async writer for the current active version. If not provided, the version is kept in memory only. The resolved value is ignored — return anything (commonly `Promise<void>`). |
| `logger`           | `function` | Optional debug logger function. Receives timestamped log messages.                                                                                          |

### MigrateFn

The function type used for migration up/down operations.

```typescript
type MigrateFn = (context?: Record<string, unknown>) => void | Promise<void>;
```

### Plan / PlanStep

Return types of [`Migrate.plan()`](#plan).

```typescript
interface PlanStep {
	version: string;           // worker to invoke at this step
	activeAfter: string | undefined; // active version after the step succeeds
}

interface Plan {
	direction: "up" | "down";
	fromVersion: string | undefined;
	toVersion: string | undefined;
	steps: PlanStep[];
}
```

### Status

Return type of [`Migrate.status()`](#status-1).

```typescript
interface Status {
	active: string | undefined;   // current active version
	latest: string | undefined;   // highest registered version
	isAtLatest: boolean;
	pending: string[];            // versions strictly above active
}
```

---

## Classes

### Migrate

The main migration manager class that handles version tracking and migration execution.

#### Constructor

```typescript
new Migrate(options?: Partial<MigrateOptions>, context?: Record<string, any>)
```

| Parameter | Type                      | Description                                                 |
| --------- | ------------------------- | ----------------------------------------------------------- |
| `options` | `Partial<MigrateOptions>` | Configuration options for version storage and logging.      |
| `context` | `Record<string, any>`     | Arbitrary context object passed to each migration function. |

#### Properties

| Property    | Type                                 | Description                                                          |
| ----------- | ------------------------------------ | -------------------------------------------------------------------- |
| `versions`  | `Version[]`                          | Array of all registered Version instances (read-only).               |
| `available` | `string[]`                           | Array of all available version strings in semver format (read-only). |
| `context`   | `Record<string, any>`                | The context object passed to migrations.                             |
| `compareFn` | `(a: Version, b: Version) => number` | The comparison function used for sorting versions (read-only).       |

#### Methods

##### addVersion

Registers a new version with its migration functions.

```typescript
addVersion(
  version: string,
  up: MigrateFn,
  down?: MigrateFn | null,
  comment?: string
): Version
```

| Parameter | Type                    | Description                                                                                                                                |
| --------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `version` | `string`                | The version string (will be normalized to semver format).                                                                                  |
| `up`      | `MigrateFn`             | The upgrade function to execute when migrating up to this version.                                                                         |
| `down`    | `MigrateFn \| null`     | The downgrade function. Pass `null` (or omit) to mark the version as **irreversible** — any `down()`/`uninstall()` that reaches it throws. |
| `comment` | `string`                | Optional comment or description for this version.                                                                                          |

**Returns:** The created `Version` instance.

**Throws:** `Error` if the version already exists.

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

##### forceSetActiveVersion

Writes the active version marker without validating that the version exists in the registered set. Intended for recovery after a partial failure (migration succeeded but the marker write failed, or the marker was left pointing at an unexpected value).

```typescript
async forceSetActiveVersion(
  version: string | undefined
): Promise<string | undefined>
```

| Parameter | Type                   | Description                                                                                                 |
| --------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `version` | `string \| undefined`  | Normalized semver string, or `undefined` to clear the marker. Unknown versions clear the in-memory active item but are still written to external storage verbatim. |

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

**Throws:** `Error` if the target version is not found or if a migration fails.

**Concurrency:** Calls to `up()`, `down()` and `uninstall()` on the same `Migrate` instance are automatically serialized — a second call won't start until the first has settled.

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

**Throws:** `Error` if there is no active version, target is not found, or if a migration fails (including when an [irreversible](#addversion) version is reached).

##### uninstall

Performs a complete uninstall by downgrading past the initial version.

```typescript
async uninstall(): Promise<number>
```

**Returns:** The number of migration steps executed.

**Throws:** `Error` if the uninstall operation fails — including when any version on the path (or the initial version itself) was registered without a `down` worker.

##### plan

Computes the steps `up` or `down` would execute for the given target **without running any migration functions or mutating state**. Useful for dry-runs, previews, and tests.

```typescript
async plan(
  direction: "up" | "down",
  target?: string
): Promise<Plan>
```

| Parameter   | Type              | Description                                                                                    |
| ----------- | ----------------- | ---------------------------------------------------------------------------------------------- |
| `direction` | `"up" \| "down"`  | Which plan to compute.                                                                          |
| `target`    | `string`          | Same target vocabulary as `up` / `down`. Defaults to `"latest"` for up, `"major"` for down.    |

**Returns:** A [`Plan`](#plan--planstep) object with resolved `fromVersion`, `toVersion`, and an ordered list of `steps`.

**Throws:** `Error` if the target cannot be resolved (or, for `"down"`, if there is no active version).

##### status

Produces a status snapshot.

```typescript
async status(): Promise<Status>
```

**Returns:** A [`Status`](#status) object with the current active version, the highest registered version, an `isAtLatest` boolean, and the list of versions strictly above the current active.

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
new Version(
  version: string,
  up: MigrateFn,
  down?: MigrateFn | null,
  comment?: string,
  logger?: (...args: unknown[]) => void
)
```

| Parameter | Type                | Description                                                                             |
| --------- | ------------------- | --------------------------------------------------------------------------------------- |
| `version` | `string`            | The version string (will be normalized to semver format).                               |
| `up`      | `MigrateFn`         | The upgrade function.                                                                   |
| `down`    | `MigrateFn \| null` | The downgrade function. `null`/omitted marks the version as irreversible (one-way).     |
| `comment` | `string`            | Optional comment or description.                                                        |
| `logger`  | `function`          | Optional logger function.                                                               |

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

Executes the upgrade migration function.

```typescript
up(context?: Record<string, unknown>): void | Promise<void>
```

##### down

Executes the downgrade migration function. Throws if the version is irreversible.

```typescript
down(context?: Record<string, unknown>): void | Promise<void>
```

##### toString

Returns the normalized version string.

```typescript
toString(): string
```

---

## Semver Utilities

### normalizeSemver

Normalizes a version string to comply with semver format (MAJOR.MINOR.PATCH). Prerelease and build identifiers must only contain semver-spec characters (`[0-9A-Za-z-.]`).

```typescript
function normalizeSemver(version: string, assert?: true): string;
function normalizeSemver(version: string, assert: false): string | undefined;
```

| Parameter | Type      | Default | Description                                                                                  |
| --------- | --------- | ------- | -------------------------------------------------------------------------------------------- |
| `version` | `string`  | -       | The version string to normalize.                                                             |
| `assert`  | `boolean` | `true`  | If `true` (default), throws `TypeError` for invalid input. If `false`, returns `undefined`.  |

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
function parseSemver(version: string): {
	major: number;
	minor: number;
	patch: number;
	prerelease: string;
	build: string;
};
```

**Returns:** An object containing the parsed version components.

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
