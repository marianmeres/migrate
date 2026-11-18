import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSqliteMigrate } from "../src/sqlite.ts";

const tables = (db: DatabaseSync) =>
	db
		.prepare(
			`select name from sqlite_master
			where type = 'table' and name not like 'sqlite_%' order by name`,
		)
		.all()
		.map((row) => row.name);

const history = (db: DatabaseSync, table = "__migrate__") =>
	db
		.prepare(`select version from ${table} order by id`)
		.all()
		.map((row) => row.version);

/** A write transaction can only begin when none is open: the run closed its own. */
const assertNoOpenTransaction = (db: DatabaseSync) => {
	db.exec("BEGIN IMMEDIATE");
	db.exec("ROLLBACK");
};

/** A temporary directory for the tests that need a database file. */
const withTempDir = async (fn: (dir: string) => Promise<void>) => {
	const dir = mkdtempSync(join(tmpdir(), "migrate-sqlite-"));
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

/**
 * The tests on a database file (and on child processes) are skipped where the runtime
 * gives no access to a temporary directory; the in-memory ones run everywhere.
 */
const needsFiles = await withTempDir(async () => {}).then(
	() => false as const,
	() => "the runtime gives no access to a temporary directory",
);

test("sqlite: up / down / uninstall", async () => {
	const db = new DatabaseSync(":memory:");
	const migrate = createSqliteMigrate(db);

	migrate.addVersion(
		"1.0.0",
		({ db }) => db.exec("create table foo (id integer primary key)"),
		({ db }) => db.exec("drop table foo"),
	);
	migrate.addVersion(
		"1.1.0",
		({ db }) => db.exec("alter table foo add column bar text"),
		({ db }) => db.exec("alter table foo drop column bar"),
	);
	migrate.addVersion(
		"2.0.0",
		({ db }) => db.exec("create table baz (id integer primary key)"),
		({ db }) => db.exec("drop table baz"),
	);

	// nothing is installed, and asking did not create the version table
	assert.deepStrictEqual(await migrate.status(), {
		active: undefined,
		latest: "2.0.0",
		isAtLatest: false,
		pending: ["1.0.0", "1.1.0", "2.0.0"],
	});
	assert.deepStrictEqual(tables(db), []);

	assert.deepStrictEqual(await migrate.up(), 3);
	assert.deepStrictEqual(await migrate.getActiveVersion(), "2.0.0");
	assert.deepStrictEqual(tables(db), ["__migrate__", "baz", "foo"]);
	assert.deepStrictEqual(history(db), ["1.0.0", "1.1.0", "2.0.0"]);

	// already there
	assert.deepStrictEqual(await migrate.up(), 0);

	assert.deepStrictEqual(await migrate.down("1.1.0"), 1);
	assert.deepStrictEqual(await migrate.getActiveVersion(), "1.1.0");
	assert.deepStrictEqual(tables(db), ["__migrate__", "foo"]);

	assert.deepStrictEqual(await migrate.uninstall(), 2);
	assert.deepStrictEqual(await migrate.getActiveVersion(), undefined);
	assert.deepStrictEqual(tables(db), ["__migrate__"]);

	// the table is the history: every change of the active version is a row
	assert.deepStrictEqual(history(db), [
		"1.0.0",
		"1.1.0",
		"2.0.0",
		"1.1.0",
		"1.0.0",
		null,
	]);

	assertNoOpenTransaction(db);
	db.close();
});

test("sqlite: a failing step is undone, the steps before it stay", async () => {
	const db = new DatabaseSync(":memory:");
	const migrate = createSqliteMigrate(db);

	migrate.addVersion(
		"1",
		({ db }) => db.exec("create table one (id integer primary key)"),
		({ db }) => db.exec("drop table one"),
	);
	migrate.addVersion(
		"2",
		({ db }) => db.exec("create table two (id integer primary key)"),
		({ db }) => db.exec("drop table two"),
	);
	migrate.addVersion(
		"3",
		({ db }) => {
			db.exec("create table three (id integer primary key)");
			db.exec("insert into no_such_table values (1)"); // fails after the DDL
		},
		({ db }) => db.exec("drop table three"),
	);

	await assert.rejects(
		() => migrate.up(),
		(e: Error) => {
			assert.match(e.message, /The upgrade to version "3\.0\.0" failed/);
			assert.match(String(e.cause), /no such table/);
			return true;
		},
	);

	// "three" is gone with the step that created it; the same run's "one" and "two" stay
	assert.deepStrictEqual(tables(db), ["__migrate__", "one", "two"]);
	assert.deepStrictEqual(await migrate.getActiveVersion(), "2.0.0");
	assert.deepStrictEqual(history(db), ["1.0.0", "2.0.0"]);

	assertNoOpenTransaction(db);
	db.close();
});

test("sqlite: another connection is locked out for the length of a run", {
	skip: needsFiles,
}, async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "test.db");
		// no busy timeout: a locked database fails at once instead of waiting
		const a = new DatabaseSync(path);
		const b = new DatabaseSync(path);

		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = () => {};
		const inside = new Promise<void>((resolve) => {
			entered = resolve;
		});

		const create = (db: DatabaseSync, hold: boolean) => {
			const migrate = createSqliteMigrate(db);
			migrate.addVersion(
				"1",
				async ({ db }) => {
					db.exec("create table foo (id integer primary key)");
					if (hold) {
						entered();
						await gate;
					}
				},
				({ db }) => db.exec("drop table foo"),
			);
			migrate.addVersion(
				"2",
				({ db }) => db.exec("create table bar (id integer primary key)"),
				({ db }) => db.exec("drop table bar"),
			);
			return migrate;
		};

		try {
			const first = create(a, true);
			const second = create(b, false);

			// the first run is in the middle of its first step...
			const running = first.up();
			await inside;

			// ...and the second cannot even start
			await assert.rejects(() => second.up(), /database is locked/);

			release();
			assert.deepStrictEqual(await running, 2);

			// now it can, and finds everything done
			assert.deepStrictEqual(await second.up(), 0);
			assert.deepStrictEqual(await second.getActiveVersion(), "2.0.0");
			assert.deepStrictEqual(history(a), ["1.0.0", "2.0.0"]);
		} finally {
			a.close();
			b.close();
		}
	});
});

test("sqlite: a second process waits for the first, then finds nothing to do", {
	skip: needsFiles,
}, async () => {
	await withTempDir(async (dir) => {
		const path = join(dir, "test.db");
		const fixture = join(import.meta.dirname, "fixtures", "sqlite-run.ts");

		/** Runs the fixture, resolving `saw` as soon as its output holds `needle`. */
		const run = (hold: number, needle: string) => {
			const child = spawn(process.execPath, [fixture, path, String(hold)], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			let found = () => {};
			const saw = new Promise<void>((resolve) => {
				found = resolve;
			});
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
				if (stdout.includes(needle)) found();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			const exited = new Promise<{ code: number | null; stdout: string }>(
				(resolve, reject) => {
					child.on("error", reject);
					child.on("close", (code) => {
						if (code === 0) resolve({ code, stdout });
						else reject(new Error(`exit ${code}: ${stderr || stdout}`));
					});
				},
			);
			return { saw, exited };
		};

		// the first process is inside its first step, holding the write lock...
		const first = run(500, "holding");
		await Promise.race([first.saw, first.exited]);

		// ...when the second one starts
		const second = run(0, "done:");

		const [one, two] = await Promise.all([first.exited, second.exited]);
		assert.match(one.stdout, /done:2/);
		// the second ran no step at all: it waited, then read the version the first left
		assert.doesNotMatch(two.stdout, /holding/);
		assert.match(two.stdout, /done:0/);

		const db = new DatabaseSync(path);
		assert.deepStrictEqual(history(db), ["1.0.0", "2.0.0"]);
		db.close();
	});
});

test("sqlite: table name and extra context", async () => {
	const db = new DatabaseSync(":memory:");

	// the name goes into SQL text
	assert.throws(
		() => createSqliteMigrate(db, { table: "x; drop table y" }),
		/Invalid table name/,
	);

	const migrate = createSqliteMigrate(db, {
		table: "my_versions",
		context: { prefix: "app_" },
	});

	migrate.addVersion(
		"1",
		(ctx) => {
			// the database is typed, and the extra context comes along
			ctx.db satisfies DatabaseSync;
			ctx.prefix satisfies string;
			ctx.db.exec(`create table ${ctx.prefix}foo (id integer primary key)`);
		},
		(ctx) => ctx.db.exec(`drop table ${ctx.prefix}foo`),
	);

	// @ts-expect-error the context has no such property
	migrate.addVersion("2", (ctx) => ctx.nope);
	await migrate.removeVersion("2");

	// @ts-expect-error a `node:sqlite` database only, not anything shaped like one
	createSqliteMigrate({ exec() {}, prepare() {} });

	assert.deepStrictEqual(await migrate.up(), 1);
	assert.deepStrictEqual(tables(db), ["app_foo", "my_versions"]);
	assert.deepStrictEqual(history(db, "my_versions"), ["1.0.0"]);

	db.close();
});

test("sqlite: the version mark can be written outside a run", async () => {
	const db = new DatabaseSync(":memory:");
	const migrate = createSqliteMigrate(db);
	migrate.addVersion(
		"1",
		() => {},
		() => {},
	);
	migrate.addVersion(
		"2",
		() => {},
		() => {},
	);

	// creates the table on its own, in its own transaction
	assert.deepStrictEqual(await migrate.forceSetActiveVersion("9.9.9"), "9.9.9");
	assert.deepStrictEqual(await migrate.getActiveVersion(), "9.9.9");

	assert.deepStrictEqual(await migrate.setActiveVersion("1"), "1.0.0");
	assert.deepStrictEqual(history(db), ["9.9.9", "1.0.0"]);

	assert.deepStrictEqual(await migrate.up(), 1);
	assert.deepStrictEqual(history(db), ["9.9.9", "1.0.0", "2.0.0"]);

	assertNoOpenTransaction(db);
	db.close();
});
