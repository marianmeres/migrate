// Run by sqlite.test.ts in a child process: migrates the given database file, holding
// its first step open for a while so that a second process has to wait for the run.
//
//   node tests/fixtures/sqlite-run.ts <database file> <hold in ms>
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { createSqliteMigrate } from "../../src/sqlite.ts";

const [path, hold] = process.argv.slice(2);

// The busy timeout is what makes this connection wait for another one's run
const db = new DatabaseSync(path, { timeout: 10_000 });
const migrate = createSqliteMigrate(db);

migrate.addVersion(
	"1.0.0",
	async ({ db }) => {
		db.exec("create table foo (id integer primary key)");
		console.log("holding");
		await sleep(Number(hold));
	},
	({ db }) => db.exec("drop table foo"),
);
migrate.addVersion(
	"2.0.0",
	({ db }) => db.exec("create table bar (id integer primary key)"),
	({ db }) => db.exec("drop table bar"),
);

console.log(`done:${await migrate.up()}`);
db.close();
