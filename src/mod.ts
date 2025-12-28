/**
 * @module
 * A general-purpose extensible versioning framework for managing incremental,
 * bi-directional changes. Works with Deno and Node.js.
 *
 * @example
 * ```typescript
 * import { Migrate } from "@marianmeres/migrate";
 *
 * const migrate = new Migrate({
 *   getActiveVersion: async (ctx) => { /* read from storage *\/ },
 *   setActiveVersion: async (version, ctx) => { /* write to storage *\/ },
 * });
 *
 * migrate.addVersion("1.0.0",
 *   async (ctx) => { /* upgrade code *\/ },
 *   async (ctx) => { /* downgrade code *\/ }
 * );
 *
 * await migrate.up("latest");
 * await migrate.down("initial");
 * await migrate.uninstall();
 * ```
 */
export * from "./migrate.ts";
export * from "./semver.ts";
