/**
 * @module
 * A general-purpose extensible versioning framework for managing incremental,
 * bi-directional changes. Works with Deno and Node.js.
 *
 * For database migrations, the `./pg` and `./sqlite` entry points return a ready-made
 * instance: a version table, a lock per run and a transaction per step.
 *
 * @example
 * ```typescript
 * import { Migrate } from "@marianmeres/migrate";
 *
 * // every `ctx` below is the second argument, with its type
 * const migrate = new Migrate({
 *   getActiveVersion: async (ctx) => { /* read from storage *\/ },
 *   setActiveVersion: async (version, ctx) => { /* write to storage *\/ },
 *   // optional: a transaction around each step, a lock around each run
 *   wrapStep: async (run, step, ctx) => { /* begin *\/ await run(); /* commit *\/ },
 *   wrapRun: async (run, info, ctx) => { /* lock *\/ await run(); /* unlock *\/ },
 * }, { db });
 *
 * migrate.addVersion("1.0.0",
 *   async (ctx) => { /* upgrade code *\/ },
 *   async (ctx) => { /* downgrade code *\/ }
 * );
 *
 * await migrate.plan("up", "latest"); // what would run, without running it
 * await migrate.up("latest");
 * await migrate.down("initial");
 * await migrate.uninstall();
 * ```
 */

// Semver utilities live in the standalone @marianmeres/semver package; re-export
// them here to preserve this package's public API surface (DRY).
export * from "@marianmeres/semver";
export * from "./migrate.ts";
