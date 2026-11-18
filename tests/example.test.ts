import assert from "node:assert/strict";
import { test } from "node:test";
import { Migrate } from "../src/mod.ts";

// The README's "Undo / redo example", statement by statement, with its comments as
// assertions. Keep the two in step.
test("undo / redo example", async () => {
	const doc: string[] = []; // the state being edited
	const history = new Migrate();
	let sequence = 0;

	// Version 0 is the empty document, so that the first action can be undone too
	await history.setActiveVersion(
		history.addVersion(
			"0",
			() => {},
			() => {},
		),
	);

	/** Records an action as the next version, then applies it. */
	async function act(up: () => unknown, down: () => unknown) {
		// A new action discards what was undone before it: it can no longer be redone
		for (const undone of (await history.status()).pending) {
			await history.removeVersion(undone);
		}
		history.addVersion(`${++sequence}`, up, down);
		await history.up();
	}

	const undo = () => history.down(); // one version back
	const redo = () => history.up("major"); // one version forward

	const add = (word: string) =>
		act(
			() => doc.push(word),
			() => doc.pop(),
		);

	await add("hey");
	await add("ho");
	await add("lets");
	await add("go");
	assert.deepStrictEqual(doc, ["hey", "ho", "lets", "go"]);
	assert.deepStrictEqual(await history.getActiveVersion(), "4.0.0");

	await undo();
	await undo();
	assert.deepStrictEqual(doc, ["hey", "ho"]);

	await redo();
	assert.deepStrictEqual(doc, ["hey", "ho", "lets"]);

	await add("rock");
	assert.deepStrictEqual(doc, ["hey", "ho", "lets", "rock"]);
	// "go" is gone
	assert.deepStrictEqual(history.available, [
		"0.0.0",
		"1.0.0",
		"2.0.0",
		"3.0.0",
		"5.0.0",
	]);

	assert.deepStrictEqual(await redo(), 0); // nothing to redo

	await history.down("initial");
	assert.deepStrictEqual(doc, []);
	assert.deepStrictEqual(await history.getActiveVersion(), "0.0.0");

	assert.deepStrictEqual(await undo(), 0); // nothing to undo

	await history.up();
	assert.deepStrictEqual(doc, ["hey", "ho", "lets", "rock"]);
	assert.deepStrictEqual(await history.getActiveVersion(), "5.0.0");
});
