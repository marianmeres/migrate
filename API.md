# API Reference

This document provides a complete reference for the `@marianmeres/migrate` package.

## Table of Contents

- [Types](#types)
  - [MigrateOptions](#migrateoptions)
  - [MigrateFn](#migratefn)
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
	) => Promise<string | undefined>;
	logger?: (...args: unknown[]) => void;
}
```

| Property           | Type       | Description                                                                                                                           |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `getActiveVersion` | `function` | Async function to read the current active version from storage (e.g., database). If not provided, the version is kept in memory only. |
| `setActiveVersion` | `function` | Async function to write the current active version to storage. If not provided, the version is kept in memory only.                   |
| `logger`           | `function` | Optional debug logger function. Receives timestamped log messages.                                                                    |

### MigrateFn

The function type used for migration up/down operations.

```typescript
type MigrateFn = (context?: Record<string, unknown>) => void | Promise<void>;
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
  down: MigrateFn,
  comment?: string
): Version
```

| Parameter | Type        | Description                                                              |
| --------- | ----------- | ------------------------------------------------------------------------ |
| `version` | `string`    | The version string (will be normalized to semver format).                |
| `up`      | `MigrateFn` | The upgrade function to execute when migrating up to this version.       |
| `down`    | `MigrateFn` | The downgrade function to execute when migrating down from this version. |
| `comment` | `string`    | Optional comment or description for this version.                        |

**Returns:** The created `Version` instance.

**Throws:** `Error` if the version already exists.

##### getActiveVersion

Gets the currently active version.

```typescript
async getActiveVersion(): Promise<string | undefined>
```

**Returns:** The active version string, or `undefined` if not set.

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
- `"minor"` - Upgrade within current major
- `"patch"` - Upgrade within current minor
- Specific version string (e.g., `"2.0.0"`)

**Returns:** The number of migration steps executed.

**Throws:** `Error` if the target version is not found or if a migration fails.

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
- `"major"` - Downgrade to previous major
- `"minor"` - Downgrade within current major
- `"patch"` - Downgrade within current minor
- Specific version string (e.g., `"1.0.0"`)

**Returns:** The number of migration steps executed.

**Throws:** `Error` if there is no active version, target is not found, or if a migration fails.

##### uninstall

Performs a complete uninstall by downgrading past the initial version.

```typescript
async uninstall(): Promise<number>
```

**Returns:** The number of migration steps executed.

**Throws:** `Error` if the uninstall operation fails.

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
  down: MigrateFn,
  comment?: string,
  logger?: (...args: any[]) => void
)
```

| Parameter | Type        | Description                                               |
| --------- | ----------- | --------------------------------------------------------- |
| `version` | `string`    | The version string (will be normalized to semver format). |
| `up`      | `MigrateFn` | The upgrade function.                                     |
| `down`    | `MigrateFn` | The downgrade function.                                   |
| `comment` | `string`    | Optional comment or description.                          |
| `logger`  | `function`  | Optional logger function.                                 |

#### Properties

| Property     | Type                  | Description                                                      |
| ------------ | --------------------- | ---------------------------------------------------------------- |
| `version`    | `string`              | The normalized semver version string (read-only).                |
| `major`      | `number`              | The major version segment (read-only).                           |
| `minor`      | `number`              | The minor version segment (read-only).                           |
| `patch`      | `number`              | The patch version segment (read-only).                           |
| `prerelease` | `string`              | The prerelease segment, e.g., `"alpha"`, `"beta.1"` (read-only). |
| `build`      | `string`              | The build metadata segment (read-only).                          |
| `comment`    | `string \| undefined` | Optional description (read-only).                                |

#### Methods

##### up

Executes the upgrade migration function.

```typescript
up(context?: Record<string, unknown>): void | Promise<void>
```

##### down

Executes the downgrade migration function.

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

Normalizes a version string to comply with semver format (MAJOR.MINOR.PATCH).

```typescript
function normalizeSemver(version: string, assert?: boolean): string;
```

| Parameter | Type      | Default | Description                                           |
| --------- | --------- | ------- | ----------------------------------------------------- |
| `version` | `string`  | -       | The version string to normalize.                      |
| `assert`  | `boolean` | `true`  | If true, throws an error for invalid version strings. |

**Returns:** The normalized semver string.

**Examples:**

```typescript
normalizeSemver("v1.2"); // "1.2.0"
normalizeSemver("7"); // "7.0.0"
normalizeSemver("7-rc.1"); // "7.0.0-rc.1"
normalizeSemver("1.2.3-alpha+build"); // "1.2.3-alpha+build"
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
