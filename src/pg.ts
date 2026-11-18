/**
 * @module
 * PostgreSQL wiring for {@linkcode Migrate}: the version table, one connection per run,
 * a lock across processes and a transaction per step.
 *
 * Nothing is imported from a database library: {@linkcode createPgMigrate} takes a
 * `pg.Pool` (node-postgres), or anything shaped like one.
 *
 * @example
 * ```typescript
 * import { createPgMigrate } from "@marianmeres/migrate/pg";
 * import pg from "pg";
 *
 * const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 * const migrate = createPgMigrate(pool);
 *
 * migrate.addVersion(
 *   "1.0.0",
 *   ({ client }) => client.query("create table users (id serial primary key)"),
 *   ({ client }) => client.query("drop table users"),
 * );
 *
 * await migrate.up();
 * ```
 */
import { Migrate } from "./migrate.ts";

/** The part of a query result the helper reads. */
export interface PgQueryResultLike {
	rows: any[];
	/** The command tag (`"COMMIT"`, `"ROLLBACK"`, ...), as node-postgres reports it. */
	command?: string;
}

/** A checked-out connection: a `pg.PoolClient`, or anything shaped like one. */
export interface PgClientLike {
	query(text: string, values?: any[]): Promise<PgQueryResultLike>;
	/** Hands the connection back to the pool; a truthy argument destroys it instead. */
	release(destroy?: Error | boolean): void;
}

/** A connection pool: a `pg.Pool`, or anything shaped like one. */
export interface PgPoolLike {
	connect(): Promise<PgClientLike>;
	query(text: string, values?: any[]): Promise<PgQueryResultLike>;
}

/**
 * The client type a pool's `connect()` resolves to: `pg.PoolClient` for a `pg.Pool`.
 * (The first branch reads the promise signature of a `connect` that is overloaded with a
 * callback form, as node-postgres declares it.)
 */
export type PgClientOf<TPool> = TPool extends {
	connect(): Promise<infer TClient>;
	connect(callback: never): unknown;
}
	? TClient
	: TPool extends { connect(): Promise<infer TClient> }
		? TClient
		: PgClientLike;

/** The context every worker of a {@linkcode createPgMigrate} instance receives. */
export interface PgMigrateContext<TClient = PgClientLike> {
	/**
	 * The one connection of the run in progress. It holds the run's lock, and the
	 * step's transaction is open on it: everything a worker does through it commits
	 * or rolls back together with the step's version mark. A worker must not issue
	 * `begin` / `commit` / `rollback` itself.
	 */
	client: TClient;
}

/** Options of {@linkcode createPgMigrate}. */
export interface PgMigrateOptions<
	TExtra extends Record<string, any> = Record<never, never>,
> {
	/**
	 * The table the active version is kept in, created when missing. Letters, digits
	 * and underscores only. Default: `"__migrate__"`.
	 */
	table?: string;
	/** Extra properties for the context every worker receives, next to `client`. */
	context?: TExtra;
	/** Optional logger for debugging purposes. */
	logger?: (...args: unknown[]) => void;
}

/** The default name of the version table. */
export const PG_MIGRATE_TABLE = "__migrate__" as const;

/** The first wait between two polls for the lock, in milliseconds. */
const LOCK_POLL_FIRST_MS = 10;
/** The longest wait between two polls: the doubling stops here. */
const LOCK_POLL_MAX_MS = 250;

/**
 * Creates a {@linkcode Migrate} instance that keeps its active version in a PostgreSQL
 * table and runs safely against a live database:
 *
 * - **One connection per run.** `up()` / `down()` / `uninstall()` check one client out
 *   of the pool and do everything on it; workers receive it as `context.client`.
 * - **One run at a time, across processes.** The run holds a session advisory lock,
 *   keyed by the table name and the current schema. A second process waits for the
 *   first, then reads the version the first left behind and finds nothing to do.
 * - **One transaction per step.** A version's worker and the write of the active
 *   version commit together or not at all.
 *
 * The version table is insert-only: its newest row is the active version, the older
 * ones are the history. A read never creates it.
 *
 * Statements that cannot run inside a transaction (`create index concurrently`, ...)
 * cannot be issued by a worker. Connect directly, not through a pooler in transaction
 * mode: the lock belongs to the session.
 *
 * @param pool - A `pg.Pool`, or anything shaped like one. The caller keeps owning it.
 * @param options - Table name, extra context, logger.
 * @returns A `Migrate` instance ready for `addVersion()`.
 * @throws {TypeError} If the table name holds anything but letters, digits and underscores.
 */
export function createPgMigrate<
	TPool extends PgPoolLike,
	TExtra extends Record<string, any> = Record<never, never>,
>(
	pool: TPool,
	options: PgMigrateOptions<TExtra> = {},
): Migrate<TExtra & PgMigrateContext<PgClientOf<TPool>>> {
	const table = options.table ?? PG_MIGRATE_TABLE;

	// The name goes into SQL text: an identifier cannot be a bound parameter
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
		throw new TypeError(
			`Invalid table name "${table}" (letters, digits and underscores only)`,
		);
	}

	const sql = {
		ensure:
			`create table if not exists ${table} (` +
			`id bigint generated always as identity primary key, ` +
			`version text null, ` +
			`created_at timestamptz not null default now())`,
		exists: `select to_regclass($1) is not null as found`,
		read: `select version from ${table} order by id desc limit 1`,
		write: `insert into ${table} (version) values ($1)`,
		// Two int4 keys: the table's and the schema's, so that two schemas of one
		// database (two deployments) do not wait for each other
		lockKey:
			`select hashtext($1) as a, ` +
			`hashtext(coalesce(current_schema(), '')) as b`,
		tryLock: `select pg_try_advisory_lock($1, $2) as ok`,
		unlock: `select pg_advisory_unlock($1, $2)`,
	};

	const log = (...args: unknown[]) =>
		options.logger?.(`[${new Date().toISOString()}] [migrate:pg]`, ...args);

	// The connection of the run in progress, and the context that shows it to the
	// workers: `client` is set for exactly as long as a run holds its connection
	let current: PgClientLike | undefined;
	const context: { client?: PgClientLike } = { ...options.context, client: undefined };

	// A connection left in an unknown state (a ROLLBACK that failed) is destroyed
	// instead of going back to the pool
	let broken: Error | undefined;

	/**
	 * Polled (`pg_try_advisory_lock`), never waited for inside a statement: a session
	 * blocked in `pg_advisory_lock` holds a snapshot for as long as it waits.
	 */
	const takeLock = async (client: PgClientLike, key: [number, number]) => {
		let wait = LOCK_POLL_FIRST_MS;
		for (let attempt = 0; ; attempt++) {
			const { rows } = await client.query(sql.tryLock, key);
			if (rows[0]?.ok === true) return;
			if (attempt === 0) log(`waiting for another run on "${table}" to finish ...`);
			await new Promise((resolve) => setTimeout(resolve, wait));
			wait = Math.min(wait * 2, LOCK_POLL_MAX_MS);
		}
	};

	/**
	 * Runs `fn` on one checked-out connection that holds the lock, with the version
	 * table in place. Re-entrant: inside a run, `fn` gets the run's connection.
	 */
	const locked = async <T>(fn: (client: PgClientLike) => Promise<T>): Promise<T> => {
		if (current) return fn(current);

		const client = await pool.connect();
		// Set when the connection must be destroyed rather than reused. Destroying it
		// is also what releases a session lock that no statement could release.
		let destroy: Error | undefined;
		broken = undefined;

		try {
			let key: [number, number];
			try {
				const { rows } = await client.query(sql.lockKey, [`migrate:${table}`]);
				key = [rows[0].a, rows[0].b];
				await takeLock(client, key);
			} catch (e) {
				// Whether the lock was taken is unknown
				destroy = e as Error;
				throw e;
			}

			try {
				await client.query(sql.ensure);
				current = context.client = client;
				return await fn(client);
			} finally {
				current = context.client = undefined;
				try {
					await client.query(sql.unlock, key);
				} catch (e) {
					destroy = e as Error;
				}
			}
		} finally {
			client.release(destroy ?? broken);
		}
	};

	const migrate = new Migrate<{ client?: PgClientLike }>(
		{
			getActiveVersion: async () => {
				// Outside a run the table may not exist yet, and a read does not create it
				if (!current) {
					const { rows } = await pool.query(sql.exists, [table]);
					if (rows[0]?.found !== true) return null;
				}
				const { rows } = await (current ?? pool).query(sql.read);
				return rows[0]?.version ?? null;
			},

			// Inside a run this is the step's own transaction. Outside one (a manual
			// `setActiveVersion()` or `forceSetActiveVersion()`) it takes the lock itself.
			setActiveVersion: (version) =>
				locked((client) => client.query(sql.write, [version ?? null])),

			wrapRun: (run) => locked(() => run()),

			wrapStep: async (run) => {
				const client = current;
				if (!client) throw new Error("A step can only run inside a run");

				await client.query("begin");
				// Set once the server has ended the transaction itself: no ROLLBACK to send
				let ended = false;
				try {
					await run();
					// COMMIT is checked, not trusted: Postgres answers the COMMIT of a
					// transaction that a failed statement aborted with ROLLBACK, and no error
					const { command } = await client.query("commit");
					if (command !== undefined && command !== "COMMIT") {
						ended = true;
						throw new Error(
							`Postgres answered COMMIT with ${command}: a statement inside the ` +
								`step failed, so nothing was committed`,
						);
					}
				} catch (e) {
					if (!ended) {
						try {
							await client.query("rollback");
						} catch (rollbackError) {
							// Keep the original failure; a failed ROLLBACK is a symptom, not
							// the cause. But the connection's state is now unknown.
							broken = rollbackError as Error;
						}
					}
					throw e;
				}
			},

			logger: options.logger,
		},
		context,
	);

	// Typed for the callers: workers only ever run inside a run, where `client` is set
	return migrate as unknown as Migrate<TExtra & PgMigrateContext<PgClientOf<TPool>>>;
}
