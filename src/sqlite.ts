/**
 * @module
 * SQLite wiring for {@linkcode Migrate}: the version table, a write lock for the whole
 * run and a savepoint per step.
 *
 * Written for `node:sqlite`, the SQLite module built into Node, and for nothing else:
 * {@linkcode createSqliteMigrate} takes a `DatabaseSync`. Only the types of that module
 * are imported, so the helper adds no dependency.
 *
 * @example
 * ```typescript
 * import { createSqliteMigrate } from "@marianmeres/migrate/sqlite";
 * import { DatabaseSync } from "node:sqlite";
 *
 * const db = new DatabaseSync("app.db", { timeout: 5000 });
 * const migrate = createSqliteMigrate(db);
 *
 * migrate.addVersion(
 *   "1.0.0",
 *   ({ db }) => db.exec("create table users (id integer primary key)"),
 *   ({ db }) => db.exec("drop table users"),
 * );
 *
 * await migrate.up();
 * ```
 */
import type { DatabaseSync } from "node:sqlite";
import { Migrate } from "./migrate.ts";

/** The context every worker of a {@linkcode createSqliteMigrate} instance receives. */
export interface SqliteMigrateContext {
	/**
	 * The database. During a run its write transaction is open: everything a worker
	 * does through it is undone together with the step's version mark when the step
	 * fails. A worker must not issue `BEGIN` / `COMMIT` / `ROLLBACK` itself.
	 */
	db: DatabaseSync;
}

/** Options of {@linkcode createSqliteMigrate}. */
export interface SqliteMigrateOptions<
	TExtra extends Record<string, any> = Record<never, never>,
> {
	/**
	 * The table the active version is kept in, created when missing. Letters, digits
	 * and underscores only. Default: `"__migrate__"`.
	 */
	table?: string;
	/** Extra properties for the context every worker receives, next to `db`. */
	context?: TExtra;
	/** Optional logger for debugging purposes. */
	logger?: (...args: unknown[]) => void;
}

/** The default name of the version table. */
export const SQLITE_MIGRATE_TABLE = "__migrate__" as const;

/** The savepoint a step runs in. */
const STEP = "migrate_step";

/**
 * Creates a {@linkcode Migrate} instance that keeps its active version in a SQLite
 * table and runs safely against a database file other connections have open:
 *
 * - **One write transaction per run.** `up()` / `down()` / `uninstall()` open
 *   `BEGIN IMMEDIATE`, which takes SQLite's write lock at once, and read the active
 *   version under it. Another connection's run waits for it, for as long as that
 *   connection's busy timeout allows, then reads the version this run left behind and
 *   finds nothing to do. With no busy timeout it fails with "database is locked".
 * - **One savepoint per step.** A version's worker and the write of the active version
 *   are kept together or undone together. When a step fails, the steps completed
 *   before it are committed.
 *
 * The version table is insert-only: its newest row is the active version, the older
 * ones are the history. A read never creates it.
 *
 * Statements that have no effect inside a transaction (`PRAGMA foreign_keys`) or cannot
 * run in one (`VACUUM`) cannot be issued by a worker. Nothing else should write through
 * the same `DatabaseSync` while a run is in progress: it would become part of the run's
 * transaction.
 *
 * @param db - A `node:sqlite` database. The caller keeps owning it, and closes it.
 * @param options - Table name, extra context, logger.
 * @returns A `Migrate` instance ready for `addVersion()`.
 * @throws {TypeError} If the table name holds anything but letters, digits and underscores.
 */
export function createSqliteMigrate<
	TExtra extends Record<string, any> = Record<never, never>,
>(
	db: DatabaseSync,
	options: SqliteMigrateOptions<TExtra> = {},
): Migrate<TExtra & SqliteMigrateContext> {
	const table = options.table ?? SQLITE_MIGRATE_TABLE;

	// The name goes into SQL text: an identifier cannot be a bound parameter
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
		throw new TypeError(
			`Invalid table name "${table}" (letters, digits and underscores only)`,
		);
	}

	const sql = {
		ensure:
			`CREATE TABLE IF NOT EXISTS ${table} (` +
			`id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
			`version TEXT NULL, ` +
			`created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`,
		exists: `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`,
		read: `SELECT version FROM ${table} ORDER BY id DESC LIMIT 1`,
		write: `INSERT INTO ${table} (version) VALUES (?)`,
	};

	// Whether the run's write transaction is open on the handle
	let inRun = false;
	// Set when a failed step could not be rolled back to its savepoint: what it left
	// behind must not be committed, so the whole run is rolled back instead
	let poisoned = false;

	/**
	 * Runs `fn` inside one `BEGIN IMMEDIATE` transaction, with the version table in
	 * place. Re-entrant: inside a run, `fn` joins the run's transaction.
	 *
	 * The transaction is committed also when `fn` throws: a failed step has already
	 * been rolled back to its own savepoint, and what completed before it stays.
	 */
	const locked = async <T>(fn: () => T | Promise<T>): Promise<T> => {
		if (inRun) return fn();

		db.exec("BEGIN IMMEDIATE");
		inRun = true;
		poisoned = false;

		let outcome: { value: T } | { error: unknown };
		try {
			db.exec(sql.ensure);
			outcome = { value: await fn() };
		} catch (error) {
			outcome = { error };
		} finally {
			inRun = false;
		}

		try {
			db.exec(poisoned ? "ROLLBACK" : "COMMIT");
		} catch (commitError) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// Keep the failure that matters; a failed ROLLBACK is a symptom of it
			}
			// The failure of the work itself, when there is one, is the one to report
			throw "error" in outcome ? outcome.error : commitError;
		}

		if ("error" in outcome) throw outcome.error;
		return outcome.value;
	};

	const context = { ...options.context, db } as TExtra & SqliteMigrateContext;

	return new Migrate<TExtra & SqliteMigrateContext>(
		{
			getActiveVersion: () => {
				// Outside a run the table may not exist yet, and a read does not create it
				if (!inRun && !db.prepare(sql.exists).get(table)) return null;
				const version = db.prepare(sql.read).get()?.version;
				return typeof version === "string" ? version : null;
			},

			// Inside a run this joins the step's savepoint. Outside one (a manual
			// `setActiveVersion()` or `forceSetActiveVersion()`) it is its own transaction.
			setActiveVersion: (version) =>
				locked(() => {
					db.prepare(sql.write).run(version ?? null);
				}),

			wrapRun: (run) => locked(run),

			wrapStep: async (run) => {
				db.exec(`SAVEPOINT ${STEP}`);
				try {
					await run();
					db.exec(`RELEASE ${STEP}`);
				} catch (e) {
					try {
						// Undo the step, then drop its savepoint: the run's transaction
						// stays open, with what the earlier steps did
						db.exec(`ROLLBACK TO ${STEP}`);
						db.exec(`RELEASE ${STEP}`);
					} catch {
						// Keep the original failure
						poisoned = true;
					}
					throw e;
				}
			},

			logger: options.logger,
		},
		context,
	);
}
