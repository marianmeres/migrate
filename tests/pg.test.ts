import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Pool, PoolClient } from "pg";
import {
	createPgMigrate,
	type PgClientLike,
	type PgPoolLike,
	type PgQueryResultLike,
} from "../src/pg.ts";

// --------------------------------------------------------------------------------------
// Against a pool that only records: no database needed, so these always run. They pin
// the statements a run issues, and the failures a real server will not produce on demand.
// --------------------------------------------------------------------------------------

/** A stand-in for `pg.Pool`: one connection, a version table kept in memory. */
function fakePool(
	script: {
		/** The command tag `commit` is answered with. */
		commitAnswer?: string;
		/** Statements matching this fail. */
		fail?: RegExp;
	} = {},
) {
	const statements: string[] = [];
	const released: (Error | boolean | undefined)[] = [];
	let tableExists = false;
	let version: string | null = null;

	const query = async (text: string, values?: any[]): Promise<PgQueryResultLike> => {
		statements.push(text.split(" (")[0]);
		if (script.fail?.test(text)) throw new Error(`refused: ${text}`);
		if (text.includes("hashtext")) return { rows: [{ a: 1, b: 2 }] };
		if (text.includes("pg_try_advisory_lock")) return { rows: [{ ok: true }] };
		if (text.includes("to_regclass")) return { rows: [{ found: tableExists }] };
		if (text.startsWith("create table if not exists")) tableExists = true;
		if (text.startsWith("select version")) {
			return { rows: version === null ? [] : [{ version }] };
		}
		if (text.startsWith("insert into")) version = values?.[0] ?? null;
		if (text === "commit") {
			return { rows: [], command: script.commitAnswer ?? "COMMIT" };
		}
		return { rows: [] };
	};

	const client: PgClientLike = {
		query,
		release: (destroy) => void released.push(destroy),
	};
	const pool: PgPoolLike = { connect: async () => client, query };

	return { pool, statements, released, getVersion: () => version };
}

test("pg: the statements of a run, in order", async () => {
	const { pool, statements, released, getVersion } = fakePool();
	const migrate = createPgMigrate(pool);
	migrate.addVersion(
		"1",
		({ client }) => client.query("create table foo"),
		({ client }) => client.query("drop table foo"),
	);

	assert.deepStrictEqual(await migrate.up(), 1);
	assert.deepStrictEqual(getVersion(), "1.0.0");
	assert.deepStrictEqual(statements, [
		// the lock first, on the run's own connection...
		"select hashtext($1) as a, hashtext(coalesce(current_schema(), '')) as b",
		"select pg_try_advisory_lock($1, $2) as ok",
		// ...then everything else under it
		"create table if not exists __migrate__",
		"select version from __migrate__ order by id desc limit 1",
		"begin",
		"create table foo",
		"insert into __migrate__",
		"commit",
		"select pg_advisory_unlock($1, $2)",
	]);
	// handed back to the pool, not destroyed
	assert.deepStrictEqual(released, [undefined]);
});

test("pg: a COMMIT that the server answers with ROLLBACK fails the step", async () => {
	// what Postgres does when a statement inside the transaction failed and its
	// error was swallowed: no error on COMMIT, just the other command tag
	const { pool, statements, released } = fakePool({ commitAnswer: "ROLLBACK" });
	const migrate = createPgMigrate(pool);
	migrate.addVersion(
		"1",
		({ client }) => client.query("create table foo"),
		() => {},
	);

	await assert.rejects(() => migrate.up(), /answered COMMIT with ROLLBACK/);
	// the transaction is over already: no ROLLBACK is sent after it
	assert.ok(!statements.includes("rollback"));
	assert.deepStrictEqual(statements.at(-1), "select pg_advisory_unlock($1, $2)");
	assert.deepStrictEqual(released, [undefined]);
});

test("pg: a connection in an unknown state is destroyed, not reused", async () => {
	const boom = () => {
		throw new Error("boom");
	};

	// the lock could not be released by statement: closing the session releases it
	const unlock = fakePool({ fail: /pg_advisory_unlock/ });
	const a = createPgMigrate(unlock.pool);
	a.addVersion(
		"1",
		() => {},
		() => {},
	);
	assert.deepStrictEqual(await a.up(), 1);
	assert.ok(unlock.released[0] instanceof Error);

	// the step failed and so did its ROLLBACK
	const rollback = fakePool({ fail: /^rollback$/ });
	const b = createPgMigrate(rollback.pool);
	b.addVersion("1", boom, () => {});
	await assert.rejects(() => b.up(), /The upgrade to version "1\.0\.0" failed/);
	assert.ok(rollback.released[0] instanceof Error);

	// whether the lock was taken is unknown
	const lock = fakePool({ fail: /pg_try_advisory_lock/ });
	const c = createPgMigrate(lock.pool);
	c.addVersion(
		"1",
		() => {},
		() => {},
	);
	await assert.rejects(() => c.up(), /refused/);
	assert.ok(lock.released[0] instanceof Error);
});

test("pg: the table name is checked, a read creates nothing", async () => {
	const { pool, statements } = fakePool();

	// the name goes into SQL text
	assert.throws(
		() => createPgMigrate(pool, { table: "x; drop table y" }),
		/Invalid table name/,
	);

	const migrate = createPgMigrate(pool, { table: "my_versions" });
	assert.deepStrictEqual(await migrate.getActiveVersion(), undefined);
	assert.deepStrictEqual(statements, ["select to_regclass($1) is not null as found"]);
});

// --------------------------------------------------------------------------------------
// Against a real server. Configured by the variables the example reads (.env.example);
// without them these are skipped, except in CI, where the database is part of the gate.
// --------------------------------------------------------------------------------------

/** An environment variable, or undefined where the runtime withholds the environment. */
const env = (name: string): string | undefined => {
	try {
		return process.env[name] || undefined;
	} catch {
		return undefined;
	}
};

const config = env("DB_DATABASE")
	? {
			host: env("DB_HOST"),
			port: env("DB_PORT") ? Number(env("DB_PORT")) : undefined,
			user: env("DB_USER"),
			password: env("DB_PASSWORD"),
			database: env("DB_DATABASE"),
		}
	: undefined;

const skip = config
	? false
	: "no database configured (DB_HOST, DB_DATABASE, DB_USER, DB_PASSWORD: see .env.example)";

// A CI run without a database must not pass by skipping everything below
if (!config && env("CI")) {
	test("pg: a database is configured in CI", () => {
		assert.fail("DB_* variables are not set: the Postgres tests would be skipped");
	});
}

/** What a server test works with. */
interface Scenario {
	/** A new pool (a new set of sessions), ended when the test is over. */
	createPool: () => Pool;
	/** The prefix of every table the test creates, its version table included. */
	p: string;
}

/**
 * A test whose tables all carry a prefix of its own, dropped afterwards: tests do not
 * see each other's tables, and two runs of the suite against one database do not
 * collide. A prefix, not a schema, because an application's user may create tables
 * but not schemas.
 */
function scenario(name: string, fn: (scenario: Scenario) => Promise<void>) {
	test(`pg (server): ${name}`, { skip }, async () => {
		const { default: pg } = await import("pg");
		const p = `mt_${crypto.randomUUID().slice(0, 8)}_`;
		const pools: Pool[] = [];
		const createPool = () => {
			const pool = new pg.Pool({ ...config, max: 3 });
			pools.push(pool);
			return pool;
		};

		try {
			await fn({ createPool, p });
		} finally {
			// the test's connections first: one left inside a transaction would block a drop
			await Promise.all(pools.map((pool) => pool.end()));

			const cleaner = new pg.Pool({ ...config, max: 1 });
			try {
				for (const table of await tables(cleaner, p)) {
					await cleaner.query(`drop table if exists ${p}${table}`);
				}
			} finally {
				await cleaner.end();
			}
		}
	});
}

/** The test's tables, without their prefix. */
const tables = async (pool: Pool, p: string): Promise<string[]> =>
	(
		await pool.query(
			`select table_name from information_schema.tables
			where table_schema = current_schema() and starts_with(table_name, $1)
			order by 1`,
			[p],
		)
	).rows.map((row) => row.table_name.slice(p.length));

const history = async (pool: Pool, p: string) =>
	(await pool.query(`select version from ${p}versions order by id`)).rows.map(
		(row) => row.version,
	);

scenario(
	"up / down / uninstall, on one connection per run",
	async ({ createPool, p }) => {
		const pool = createPool();
		const migrate = createPgMigrate(pool, { table: `${p}versions` });

		const sessions = new Set<number>();
		const note = async (client: PoolClient) => {
			const { rows } = await client.query("select pg_backend_pid() as pid");
			sessions.add(rows[0].pid);
		};

		migrate.addVersion(
			"1.0.0",
			async ({ client }) => {
				// the pool's own client type reaches the worker
				client satisfies PoolClient;
				await note(client);
				await client.query(`create table ${p}foo (id serial primary key)`);
			},
			({ client }) => client.query(`drop table ${p}foo`),
		);
		migrate.addVersion(
			"1.1.0",
			async ({ client }) => {
				await note(client);
				await client.query(`alter table ${p}foo add bar text`);
			},
			({ client }) => client.query(`alter table ${p}foo drop bar`),
		);
		migrate.addVersion(
			"2.0.0",
			async ({ client }) => {
				await note(client);
				await client.query(`create table ${p}baz (id serial primary key)`);
			},
			({ client }) => client.query(`drop table ${p}baz`),
		);

		// nothing is installed, and asking did not create the version table
		assert.deepStrictEqual(await migrate.status(), {
			active: undefined,
			latest: "2.0.0",
			isAtLatest: false,
			pending: ["1.0.0", "1.1.0", "2.0.0"],
		});
		assert.deepStrictEqual(await tables(pool, p), []);

		assert.deepStrictEqual(await migrate.up(), 3);
		assert.deepStrictEqual(sessions.size, 1);
		assert.deepStrictEqual(await migrate.getActiveVersion(), "2.0.0");
		assert.deepStrictEqual(await tables(pool, p), ["baz", "foo", "versions"]);
		assert.deepStrictEqual(await history(pool, p), ["1.0.0", "1.1.0", "2.0.0"]);

		// already there
		assert.deepStrictEqual(await migrate.up(), 0);

		assert.deepStrictEqual(await migrate.down("1.1.0"), 1);
		assert.deepStrictEqual(await migrate.getActiveVersion(), "1.1.0");
		assert.deepStrictEqual(await tables(pool, p), ["foo", "versions"]);

		assert.deepStrictEqual(await migrate.uninstall(), 2);
		assert.deepStrictEqual(await migrate.getActiveVersion(), undefined);
		assert.deepStrictEqual(await tables(pool, p), ["versions"]);

		// the table is the history: every change of the active version is a row
		assert.deepStrictEqual(await history(pool, p), [
			"1.0.0",
			"1.1.0",
			"2.0.0",
			"1.1.0",
			"1.0.0",
			null,
		]);

		// every connection is back in the pool
		assert.deepStrictEqual(pool.idleCount, pool.totalCount);
	},
);

scenario(
	"a failing step leaves nothing behind, and releases the lock",
	async ({ createPool, p }) => {
		const pool = createPool();
		const migrate = createPgMigrate(pool, { table: `${p}versions` });

		migrate.addVersion(
			"1",
			({ client }) => client.query(`create table ${p}one (id int)`),
			({ client }) => client.query(`drop table ${p}one`),
		);
		migrate.addVersion(
			"2",
			async ({ client }) => {
				await client.query(`create table ${p}two (id int)`);
				await client.query("select 1/0"); // fails after the DDL
			},
			({ client }) => client.query(`drop table ${p}two`),
		);

		const failsOnTwo = (e: Error) => {
			assert.match(e.message, /The upgrade to version "2\.0\.0" failed/);
			// the driver's own error, with its code, is the cause
			assert.deepStrictEqual((e.cause as { code?: string }).code, "22012");
			return true;
		};
		await assert.rejects(() => migrate.up(), failsOnTwo);

		// "two" went with the transaction of the step that created it
		assert.deepStrictEqual(await tables(pool, p), ["one", "versions"]);
		assert.deepStrictEqual(await migrate.getActiveVersion(), "1.0.0");
		assert.deepStrictEqual(await history(pool, p), ["1.0.0"]);
		assert.deepStrictEqual(pool.idleCount, pool.totalCount);

		// the lock is free again: the next run gets as far as the same failure
		await assert.rejects(() => migrate.up(), failsOnTwo);
	},
);

scenario(
	"of two runs at once, one migrates and the other finds nothing to do",
	async ({ createPool, p }) => {
		// two pools are two sets of sessions, as two processes would be
		const create = (pool: Pool) => {
			const migrate = createPgMigrate(pool, { table: `${p}versions` });
			migrate.addVersion(
				"1",
				async ({ client }) => {
					await client.query(`create table ${p}foo (id int)`);
					await sleep(150); // long enough for the other run to arrive and wait
				},
				({ client }) => client.query(`drop table ${p}foo`),
			);
			migrate.addVersion(
				"2",
				({ client }) => client.query(`create table ${p}bar (id int)`),
				({ client }) => client.query(`drop table ${p}bar`),
			);
			return migrate;
		};

		const a = createPool();
		const b = createPool();
		const steps = await Promise.all([create(a).up(), create(b).up()]);

		// whichever came first did both steps; a second "create table" would have failed
		assert.deepStrictEqual(steps.toSorted(), [0, 2]);
		assert.deepStrictEqual(await history(a, p), ["1.0.0", "2.0.0"]);
	},
);

scenario(
	"a version table shaped by the 1.x example is used as it is",
	async ({ createPool, p }) => {
		const pool = createPool();
		await pool.query(`
		create table ${p}versions (
			id serial primary key,
			version varchar(255) null,
			created_at timestamp with time zone not null default now()
		)`);
		await pool.query(`insert into ${p}versions (version) values ('1.0.0')`);
		await pool.query(`create table ${p}foo (id int)`);

		const migrate = createPgMigrate(pool, { table: `${p}versions` });
		migrate.addVersion(
			"1.0.0",
			({ client }) => client.query(`create table ${p}foo (id int)`),
			({ client }) => client.query(`drop table ${p}foo`),
		);
		migrate.addVersion(
			"1.1.0",
			({ client }) => client.query(`alter table ${p}foo add bar text`),
			({ client }) => client.query(`alter table ${p}foo drop bar`),
		);

		assert.deepStrictEqual(await migrate.getActiveVersion(), "1.0.0");
		assert.deepStrictEqual(await migrate.up(), 1);
		assert.deepStrictEqual(await history(pool, p), ["1.0.0", "1.1.0"]);
	},
);

scenario("extra context, and a mark written outside a run", async ({ createPool, p }) => {
	const pool = createPool();
	const migrate = createPgMigrate(pool, {
		table: `${p}versions`,
		context: { name: `${p}foo` },
	});

	migrate.addVersion(
		"1",
		(ctx) => {
			ctx.name satisfies string;
			return ctx.client.query(`create table ${ctx.name} (id int)`);
		},
		(ctx) => ctx.client.query(`drop table ${ctx.name}`),
	);
	migrate.addVersion(
		"2",
		() => {},
		() => {},
	);

	// @ts-expect-error the context has no such property
	migrate.addVersion("3", (ctx) => ctx.nope);
	await migrate.removeVersion("3");

	// outside a run the write takes the lock, and creates the table, on its own
	assert.deepStrictEqual(await migrate.forceSetActiveVersion("9.9.9"), "9.9.9");
	assert.deepStrictEqual(await migrate.getActiveVersion(), "9.9.9");
	assert.deepStrictEqual(await tables(pool, p), ["versions"]);
	await migrate.forceSetActiveVersion(undefined);

	assert.deepStrictEqual(await migrate.up(), 2);
	assert.deepStrictEqual(await tables(pool, p), ["foo", "versions"]);
	assert.deepStrictEqual(await history(pool, p), ["9.9.9", null, "1.0.0", "2.0.0"]);
	assert.deepStrictEqual(pool.idleCount, pool.totalCount);
});
