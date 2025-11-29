import { assertRejects } from "@std/assert";
import { assertEquals } from "@std/assert/equals";
import { Migrate, Version } from "../src/mod.ts";

const clog = console.log;

Deno.test("progress tracking example", async () => {
	// external db example
	const db: any[] = [];
	let sequence = 1;

	//
	const app = new Migrate();

	// creates wrapper which will do some work,
	// and also internally saves a progress step version
	const work = async (thing: string) => {
		// "up" (do the work)
		const up = () => {
			db.push(thing);
		};

		// "down" (revert the work)
		const down = () => {
			db.pop();
		};

		// do the thing now
		await up();

		// add the version into internal stack
		const ver = app.addVersion(`${sequence++}`, up, down);

		// mark current version as active
		await app.setActiveVersion(ver);
	};

	// first action marks the "initial" version (1.0.0)
	await work("hey"); // 1.0.0
	await work("ho"); // 2.0.0
	await work("lets"); // 3.0.0
	await work("go"); // 4.0.0

	// check if the work was done
	assertEquals(db, ["hey", "ho", "lets", "go"]);
	assertEquals(await app.getActiveVersion(), "4.0.0");

	// undo all steps in sequence (one step at a time)
	// the below could be written as: `await progress.down("initial");`
	let result = 0;
	do {
		result = await app.down(); // one major step down
	} while (result);

	// we must be at the initial state (v1)
	assertEquals(db, ["hey"]);
	assertEquals(await app.getActiveVersion(), "1.0.0");

	// now redo all steps in one call (internally still will do step-by-step)
	await app.up("latest");
	assertEquals(db, ["hey", "ho", "lets", "go"]);

	// now go back to second version (step)
	await app.down("v2"); // "v2" is semver normalized to "2.0.0"
	assertEquals(await app.getActiveVersion(), "2.0.0");
	assertEquals(db, ["hey", "ho"]);

	// now try to go to some high version which does not exist
	assertRejects(() => app.up("12.34.56"), "Unable to find");

	// we are still in the last version
	assertEquals(await app.getActiveVersion(), "2.0.0");
	assertEquals(db, ["hey", "ho"]);

	// now remove altogether
	await app.uninstall();
	assertEquals(await app.getActiveVersion(), undefined);
	assertEquals(db, []);
});
