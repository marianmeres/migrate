import assert from "node:assert/strict";
import { test } from "node:test";
import { Migrate, type MigrateOptions, Version } from "../src/migrate.ts";

const clog = console.log;
const noop = (_c: any) => Promise.resolve();

function create_migrate(options: Partial<MigrateOptions> = {}, versionsCount = 4) {
	const log: any[] = ["clean"]; // just some marker

	// simulate external version store
	let version: string | undefined;

	const createUp = (s: string) => () => {
		// console.log(">>> pushing", s);
		log.push(s);
		return Promise.resolve();
	};

	const createDown = () => () => {
		const popped = log.pop();
		// console.log("<<< popping", popped);
		return Promise.resolve();
	};

	const migrate = new Migrate({
		getActiveVersion: () => Promise.resolve(version),
		setActiveVersion: (v: string | undefined, _ctx) => Promise.resolve((version = v)),
		...options,
	});

	//
	const letters: string[] = "abcdefghijklmnopqrstuvwxyz".split("");
	for (let i = Math.min(letters.length, versionsCount); i > 0; i--) {
		migrate.addVersion(`v${i}`, createUp(letters.at(i - 1)!), createDown());
	}

	return {
		migrate,
		getLog: () => log,
		getVersion: () => version,
		setVersion: (v: string) => (version = v),
		createUp,
		createDown,
	};
}

test("version is semver normalized", () => {
	const v = new Version("1.2-foo+bar", noop, noop, "foo");
	assert.deepStrictEqual(v.version, "1.2.0-foo+bar");
	assert.deepStrictEqual(v.major, 1);
	assert.deepStrictEqual(v.minor, 2);
	assert.deepStrictEqual(v.patch, 0);
	assert.deepStrictEqual(v.prerelease, "foo");
	assert.deepStrictEqual(v.build, "bar");
	assert.deepStrictEqual(v.comment, "foo");
});

test("sanity check", async () => {
	const m = new Migrate();
	["v4", "v1", "v2", "3.5", "v3.5.0-foo"].forEach((v) => m.addVersion(v, noop, noop));

	assert.deepStrictEqual(m.available, [
		"1.0.0",
		"2.0.0",
		"3.5.0-foo",
		"3.5.0",
		"4.0.0",
	]);

	// current version must be undefined
	const v = await m.getActiveVersion();
	assert.deepStrictEqual(v, undefined);

	// adding the same must fail
	assert.throws(() => m.addVersion("v1", noop, noop));

	// indexOf
	assert.deepStrictEqual(m.indexOf("v2"), 1);
	assert.deepStrictEqual(m.indexOf("v2.0"), 1);
	assert.deepStrictEqual(m.indexOf("v2.0.0"), 1);
	assert.deepStrictEqual(m.indexOf("9.8.7"), -1);

	// search works
	assert.deepStrictEqual(
		m.__versions
			.search("3.", "prefix")
			.toSorted(m.compareFn)
			.map((i) => i.version),
		["3.5.0-foo", "3.5.0"],
	);

	//
	assert.deepStrictEqual(await m.setActiveVersion("latest"), "4.0.0");
	assert.deepStrictEqual(await m.setActiveVersion("initial"), "1.0.0");

	// set nonexisting must throw
	await assert.rejects(() => m.setActiveVersion("7.8.9"));
});

test("single first version", async () => {
	const { migrate: m, getLog } = create_migrate(
		{
			// logger: clog,
		},
		1,
	);

	// we only have 1 version
	assert.deepStrictEqual(m.versions.length, 1);
	assert.deepStrictEqual(await m.getActiveVersion(), undefined);
	assert.deepStrictEqual(await m.up("latest"), 1);
	assert.deepStrictEqual(await m.getActiveVersion(), "1.0.0");
});

test("up/down meta", async () => {
	const { migrate: m, getLog } = create_migrate({
		// logger: clog,
	});

	// prettier-ignore
	[
		"1.0.1",
		"1.0.2",
		"1.1.0",
		"1.2.0",
		"1.2.1",
		"1.2.2",
		// intentionally create gap of missing 5x and 6x
		"7.8.9",
		"10.11.12",
	].forEach((v) => {
		m.addVersion(v, noop, noop);
	});

	// clog(m.__versions.searchable?.__index.dump());

	assert.deepStrictEqual(await m.__upMeta("patch"), {
		fromVersion: "1.0.0",
		fromIndex: 0,
		toVersion: "1.0.2",
		toIndex: 2,
		isInitial: true, // because internal version is undefined
	});

	assert.deepStrictEqual(await m.__upMeta("minor"), {
		fromVersion: "1.0.0",
		fromIndex: 0,
		toVersion: "1.2.2",
		toIndex: 6,
		isInitial: true, // because internal version is undefined
	});

	assert.deepStrictEqual((await m.__upMeta("major"))?.toVersion, "2.0.0");
	assert.deepStrictEqual((await m.__upMeta("latest"))?.toVersion, "10.11.12");

	await m.setActiveVersion("4");
	assert.deepStrictEqual(await m.getActiveVersion(), "4.0.0");

	assert.deepStrictEqual(await m.__upMeta("patch"), {
		fromVersion: "4.0.0",
		fromIndex: 9,
		toVersion: "4.0.0",
		toIndex: 9,
		isInitial: false, // because internal version IS defined already
	});

	assert.deepStrictEqual(await m.__upMeta("minor"), {
		fromVersion: "4.0.0",
		fromIndex: 9,
		toVersion: "4.0.0",
		toIndex: 9,
		isInitial: false,
	});

	// this must find the next after the gap, but not the latest
	assert.deepStrictEqual(await m.__upMeta("major"), {
		fromVersion: "4.0.0",
		fromIndex: m.available.indexOf("4.0.0"),
		toVersion: "7.8.9",
		toIndex: m.available.indexOf("7.8.9"),
		isInitial: false,
	});

	//
	assert.deepStrictEqual(await m.__upMeta("123.456.789"), {
		fromVersion: "4.0.0",
		fromIndex: m.available.indexOf("4.0.0"),
		toVersion: undefined,
		toIndex: -1,
		isInitial: false,
	});

	// clog(m.available, await m.getActiveVersion());

	assert.deepStrictEqual(await m.__downMeta("major"), {
		fromVersion: "4.0.0",
		fromIndex: m.available.indexOf("4.0.0"),
		toVersion: "3.0.0",
		toIndex: m.available.indexOf("3.0.0"),
	});

	assert.deepStrictEqual(await m.__downMeta("1.2.2"), {
		fromVersion: "4.0.0",
		fromIndex: m.available.indexOf("4.0.0"),
		toVersion: "1.2.2",
		toIndex: m.available.indexOf("1.2.2"),
	});

	await m.setActiveVersion("1.2.2");

	assert.deepStrictEqual(await m.__downMeta("patch"), {
		fromVersion: "1.2.2",
		fromIndex: m.available.indexOf("1.2.2"),
		toVersion: "1.2.1",
		toIndex: m.available.indexOf("1.2.1"),
	});

	assert.deepStrictEqual(await m.__downMeta("minor"), {
		fromVersion: "1.2.2",
		fromIndex: m.available.indexOf("1.2.2"),
		toVersion: "1.1.0",
		toIndex: m.available.indexOf("1.1.0"),
	});

	// not existing
	assert.deepStrictEqual(await m.__upMeta("123.456.789"), {
		fromVersion: "1.2.2",
		fromIndex: m.available.indexOf("1.2.2"),
		toVersion: undefined,
		toIndex: -1,
		isInitial: false,
	});

	assert.deepStrictEqual(await m.__downMeta("0.0.456"), {
		fromVersion: "1.2.2",
		fromIndex: 6,
		toVersion: undefined,
		toIndex: -1,
	});
});

test("up down", async () => {
	const { migrate: m, getLog } = create_migrate({
		// logger: clog,
	});
	assert.deepStrictEqual(await m.getActiveVersion(), undefined);
	assert.deepStrictEqual(m.available, ["1.0.0", "2.0.0", "3.0.0", "4.0.0"]);

	// down from undef throws
	await assert.rejects(() => m.__downMeta("initial"));

	// up latest
	assert.deepStrictEqual(await m.up("latest"), 4); // "4" because initial
	assert.deepStrictEqual(await m.getActiveVersion(), "4.0.0");
	assert.deepStrictEqual(getLog(), ["clean", "a", "b", "c", "d"]);

	// down to initial (note, that this does not remove completely)
	assert.deepStrictEqual(await m.down("initial"), 3);
	assert.deepStrictEqual(await m.getActiveVersion(), "1.0.0");
	assert.deepStrictEqual(getLog(), ["clean", "a"]); //

	// back to latest
	assert.deepStrictEqual(await m.up("latest"), 3); // not 4 as above, because we're already at 1.0.0
	assert.deepStrictEqual(await m.getActiveVersion(), "4.0.0");
	assert.deepStrictEqual(getLog(), ["clean", "a", "b", "c", "d"]);

	// down to 2
	assert.deepStrictEqual(await m.down("v2"), 2);
	assert.deepStrictEqual(await m.getActiveVersion(), "2.0.0");
	assert.deepStrictEqual(getLog(), ["clean", "a", "b"]);

	// up to 3 (defined as next major)
	assert.deepStrictEqual(await m.up("major"), 1);
	assert.deepStrictEqual(await m.getActiveVersion(), "3.0.0");
	assert.deepStrictEqual(getLog(), ["clean", "a", "b", "c"]);

	// back to latest
	assert.deepStrictEqual(await m.up("latest"), 1);
	assert.deepStrictEqual(await m.getActiveVersion(), "4.0.0");
	assert.deepStrictEqual(getLog(), ["clean", "a", "b", "c", "d"]);

	// now remove altogether
	assert.deepStrictEqual(await m.uninstall(), 4);
	assert.deepStrictEqual(await m.getActiveVersion(), undefined);
	assert.deepStrictEqual(getLog(), ["clean"]); //

	// this will be now a clean install
	assert.deepStrictEqual(await m.up(), 4);
	assert.deepStrictEqual(await m.getActiveVersion(), "4.0.0");
	assert.deepStrictEqual(getLog(), ["clean", "a", "b", "c", "d"]);
});

test("up('patch') bridges prerelease to release (H3)", async () => {
	const m = new Migrate();
	m.addVersion("1.0.0-alpha", noop, noop);
	m.addVersion("1.0.0", noop, noop);
	m.addVersion("1.0.1", noop, noop);
	m.addVersion("1.1.0", noop, noop);

	await m.setActiveVersion("1.0.0-alpha");

	// "patch" from a prerelease should reach the release (and its patch successors)
	const meta = await m.__upMeta("patch");
	assert.deepStrictEqual(meta?.toVersion, "1.0.1");

	// "minor" from a prerelease should reach into higher minor
	const minorMeta = await m.__upMeta("minor");
	assert.deepStrictEqual(minorMeta?.toVersion, "1.1.0");
});

test("down('patch') bridges release to prerelease (H3)", async () => {
	const m = new Migrate();
	m.addVersion("1.0.0-alpha", noop, noop);
	m.addVersion("1.0.0", noop, noop);

	await m.setActiveVersion("1.0.0");
	const meta = await m.__downMeta("patch");
	assert.deepStrictEqual(meta?.toVersion, "1.0.0-alpha");
});

test("cold-start syncs internal active from external getter (H4)", async () => {
	let externalVersion: string | undefined = "2.0.0";
	const m = new Migrate({
		getActiveVersion: () => Promise.resolve(externalVersion),
		setActiveVersion: (v) => {
			externalVersion = v;
			return Promise.resolve();
		},
	});
	m.addVersion("1.0.0", noop, noop);
	m.addVersion("2.0.0", noop, noop);
	m.addVersion("3.0.0", noop, noop);

	// Internal not synced yet (read into a local: node:assert's `asserts` signature would
	// otherwise narrow `m.__versions.active` to undefined for the rest of the test)
	const coldActive = m.__versions.active;
	assert.deepStrictEqual(coldActive, undefined);
	// Reading through public API should sync internal state
	assert.deepStrictEqual(await m.getActiveVersion(), "2.0.0");
	assert.deepStrictEqual(m.__versions.active?.version, "2.0.0");

	// And it stays in sync when external changes
	externalVersion = "3.0.0";
	assert.deepStrictEqual(await m.getActiveVersion(), "3.0.0");
	assert.deepStrictEqual(m.__versions.active?.version, "3.0.0");

	// Undefined clears internal too
	externalVersion = undefined;
	assert.deepStrictEqual(await m.getActiveVersion(), undefined);
	assert.deepStrictEqual(m.__versions.active, undefined);
});

test("concurrent up() calls are serialized (M1)", async () => {
	const events: string[] = [];
	const slow =
		(tag: string, ms = 5) =>
		() =>
			new Promise<void>((r) => {
				events.push(`start-${tag}`);
				setTimeout(() => {
					events.push(`end-${tag}`);
					r();
				}, ms);
			});

	const m = new Migrate();
	m.addVersion("1.0.0", slow("v1"), noop);
	m.addVersion("2.0.0", slow("v2"), noop);

	const [a, b] = await Promise.all([m.up("latest"), m.up("latest")]);

	// First call runs all migrations, second sees nothing to do
	assert.deepStrictEqual(a, 2);
	assert.deepStrictEqual(b, 0);

	// No interleaving: every start is followed by its own end before next start
	for (let i = 0; i < events.length; i += 2) {
		const [startTag] = events[i].split("-").slice(1);
		const [endEvent, endTag] = events[i + 1].split("-");
		assert.deepStrictEqual(endEvent, "end");
		assert.deepStrictEqual(endTag, startTag);
	}
});

test("forceSetActiveVersion recovery helper (M2)", async () => {
	let externalVersion: string | undefined;
	const m = new Migrate({
		getActiveVersion: () => Promise.resolve(externalVersion),
		setActiveVersion: (v) => {
			externalVersion = v;
			return Promise.resolve();
		},
	});
	m.addVersion("1.0.0", noop, noop);
	m.addVersion("2.0.0", noop, noop);

	// Force to a known version
	assert.deepStrictEqual(await m.forceSetActiveVersion("2.0.0"), "2.0.0");
	assert.deepStrictEqual(externalVersion, "2.0.0");
	assert.deepStrictEqual(m.__versions.active?.version, "2.0.0");

	// Force to a version unknown to the registry: external is still written,
	// internal active is cleared rather than inventing a ghost.
	assert.deepStrictEqual(await m.forceSetActiveVersion("9.9.9"), "9.9.9");
	assert.deepStrictEqual(externalVersion, "9.9.9");
	assert.deepStrictEqual(m.__versions.active, undefined);

	// Clear
	assert.deepStrictEqual(await m.forceSetActiveVersion(undefined), undefined);
	assert.deepStrictEqual(externalVersion, undefined);
});

test("irreversible migrations (M5)", async () => {
	const m = new Migrate();

	// null marks a one-way migration
	const v1 = m.addVersion("1.0.0", noop, noop);
	const v2 = m.addVersion("2.0.0", noop, null);
	const v3 = m.addVersion("3.0.0", noop, noop);

	assert.ok(v1.isReversible);
	assert.ok(!v2.isReversible);
	assert.ok(v3.isReversible);

	await m.up("latest");
	assert.deepStrictEqual(await m.getActiveVersion(), "3.0.0");

	// Down from 3.0.0 to 2.0.0 works (calls v3.down)
	await m.down(); // major: from 3 to 2
	assert.deepStrictEqual(await m.getActiveVersion(), "2.0.0");

	// Further down is refused: v2 has no down worker
	await assert.rejects(() => m.down("initial"));

	// And uninstall on a one-way initial fails loudly too
	const m2 = new Migrate();
	m2.addVersion("1.0.0", noop, null);
	await m2.up("latest");
	await assert.rejects(() => m2.uninstall());
});

test("up() does not mutate state when migration throws", async () => {
	const m = new Migrate();
	m.addVersion("1.0.0", noop, noop);
	m.addVersion(
		"2.0.0",
		() => {
			throw new Error("boom");
		},
		noop,
	);
	m.addVersion("3.0.0", noop, noop);

	await assert.rejects(() => m.up("latest"));
	// We got to 1.0.0, failed on 2.0.0 - active should be 1.0.0, not 2.0.0
	assert.deepStrictEqual(await m.getActiveVersion(), "1.0.0");
});

test("an unknown target is refused, and nothing runs", async () => {
	const { migrate, getLog } = create_migrate();
	await migrate.up("v2");
	assert.deepStrictEqual(getLog(), ["clean", "a", "b"]);

	await assert.rejects(() => migrate.up("12.34.56"), /Unable to find matching up/);
	await assert.rejects(() => migrate.down("0.0.1"), /Unable to find matching down/);

	assert.deepStrictEqual(await migrate.getActiveVersion(), "2.0.0");
	assert.deepStrictEqual(getLog(), ["clean", "a", "b"]);
});

test("plan() produces steps without mutating state", async () => {
	const m = new Migrate();
	m.addVersion("1.0.0", noop, noop);
	m.addVersion("2.0.0", noop, noop);
	m.addVersion("3.0.0", noop, noop);

	const upPlan = await m.plan("up", "latest");
	assert.deepStrictEqual(upPlan.direction, "up");
	assert.deepStrictEqual(upPlan.fromVersion, undefined);
	assert.deepStrictEqual(upPlan.toVersion, "3.0.0");
	assert.deepStrictEqual(
		upPlan.steps.map((s) => s.version),
		["1.0.0", "2.0.0", "3.0.0"],
	);
	// State is unchanged
	assert.deepStrictEqual(await m.getActiveVersion(), undefined);

	await m.up("latest");
	const downPlan = await m.plan("down", "initial");
	assert.deepStrictEqual(downPlan.direction, "down");
	assert.deepStrictEqual(downPlan.fromVersion, "3.0.0");
	assert.deepStrictEqual(downPlan.toVersion, "1.0.0");
	assert.deepStrictEqual(
		downPlan.steps.map((s) => s.version),
		["3.0.0", "2.0.0"],
	);
	assert.deepStrictEqual(
		downPlan.steps.map((s) => s.activeAfter),
		["2.0.0", "1.0.0"],
	);
});

test("status() reports pending migrations", async () => {
	const m = new Migrate();
	m.addVersion("1.0.0", noop, noop);
	m.addVersion("2.0.0", noop, noop);
	m.addVersion("3.0.0", noop, noop);

	let s = await m.status();
	assert.deepStrictEqual(s.active, undefined);
	assert.deepStrictEqual(s.latest, "3.0.0");
	assert.deepStrictEqual(s.isAtLatest, false);
	assert.deepStrictEqual(s.pending, ["1.0.0", "2.0.0", "3.0.0"]);

	await m.setActiveVersion("2.0.0");
	s = await m.status();
	assert.deepStrictEqual(s.active, "2.0.0");
	assert.deepStrictEqual(s.pending, ["3.0.0"]);
	assert.deepStrictEqual(s.isAtLatest, false);

	await m.setActiveVersion("3.0.0");
	s = await m.status();
	assert.deepStrictEqual(s.isAtLatest, true);
	assert.deepStrictEqual(s.pending, []);
});

// `Version.comment` and `Migrate.context` were constructor parameter properties, which
// Node's type stripping refuses; they are now declared fields assigned in the
// constructor. Pins that both stay public own properties, in the published key order,
// and that `context` is the object given (or a fresh `{}` by default).
test("comment and context stay public own properties", () => {
	const v = new Version("1.2.3", noop, noop, "foo");
	assert.strictEqual(v.comment, "foo");
	assert.deepStrictEqual(Object.keys(v), [
		"comment",
		"version",
		"major",
		"minor",
		"patch",
		"prerelease",
		"build",
	]);
	assert.ok(Object.hasOwn(new Version("1", noop), "comment"));
	assert.strictEqual(new Version("1", noop).comment, undefined);

	const ctx = { pool: 1 };
	const m = new Migrate({}, ctx);
	assert.strictEqual(m.context, ctx);
	assert.deepStrictEqual(Object.keys(m), ["context"]);

	const a = new Migrate();
	const b = new Migrate();
	assert.deepStrictEqual(a.context, {});
	assert.notStrictEqual(a.context, b.context);
});

test("down() refuses a path across an irreversible version before running any of it", async () => {
	const ran: string[] = [];
	const m = new Migrate();
	m.addVersion("1", noop, () => void ran.push("down1"));
	m.addVersion("2", noop, null);
	m.addVersion("3", noop, () => void ran.push("down3"));
	m.addVersion("4", noop, () => void ran.push("down4"));
	await m.up();

	// the plan shows it upfront
	const plan = await m.plan("down", "initial");
	assert.deepStrictEqual(
		plan.steps.map((s) => [s.version, s.reversible]),
		[
			["4.0.0", true],
			["3.0.0", true],
			["2.0.0", false],
		],
	);

	// nothing above the irreversible version is rolled back either
	await assert.rejects(() => m.down("initial"), /version "2\.0\.0" is irreversible/);
	assert.deepStrictEqual(ran, []);
	assert.deepStrictEqual(await m.getActiveVersion(), "4.0.0");

	// a path that stops at the irreversible version does not need its `down`
	assert.deepStrictEqual(await m.down("2"), 2);
	assert.deepStrictEqual(ran, ["down4", "down3"]);
	assert.deepStrictEqual(await m.getActiveVersion(), "2.0.0");
});

test("uninstall() is planned, and refused upfront when the path is irreversible", async () => {
	const ran: string[] = [];
	const down = (tag: string) => () => void ran.push(tag);

	const m = new Migrate();
	m.addVersion("1", noop, down("down1"));
	m.addVersion("2", noop, down("down2"));
	m.addVersion("3", noop, down("down3"));

	// nothing installed, nothing to uninstall
	assert.deepStrictEqual(await m.plan("uninstall"), {
		direction: "down",
		fromVersion: undefined,
		toVersion: undefined,
		steps: [],
	});
	assert.deepStrictEqual(await m.uninstall(), 0);

	// unlike down("initial"), the plan includes the initial version's own `down`
	await m.up();
	assert.deepStrictEqual(await m.plan("uninstall"), {
		direction: "down",
		fromVersion: "3.0.0",
		toVersion: undefined,
		steps: [
			{ version: "3.0.0", activeAfter: "2.0.0", reversible: true },
			{ version: "2.0.0", activeAfter: "1.0.0", reversible: true },
			{ version: "1.0.0", activeAfter: undefined, reversible: true },
		],
	});
	assert.deepStrictEqual(await m.uninstall(), 3);
	assert.deepStrictEqual(ran, ["down3", "down2", "down1"]);
	assert.deepStrictEqual(await m.getActiveVersion(), undefined);

	// a one-way initial version: refused before the versions above it are touched
	ran.length = 0;
	const m2 = new Migrate();
	m2.addVersion("1", noop, null);
	m2.addVersion("2", noop, down("down2"));
	await m2.up();
	await assert.rejects(() => m2.uninstall(), /version "1\.0\.0" is irreversible/);
	assert.deepStrictEqual(ran, []);
	assert.deepStrictEqual(await m2.getActiveVersion(), "2.0.0");
});

test("wrapStep wraps the worker and the marker write of every step", async () => {
	const events: string[] = [];
	let stored: string | undefined;

	const m = new Migrate({
		getActiveVersion: () => stored,
		setActiveVersion: (v) => {
			events.push(`mark:${v}`);
			stored = v;
		},
		wrapStep: async (run, step) => {
			events.push(`begin:${step.direction}:${step.version}`);
			await run();
			events.push(`commit:${step.activeAfter}`);
		},
	});
	m.addVersion(
		"1",
		() => void events.push("up1"),
		() => void events.push("down1"),
	);
	m.addVersion(
		"2",
		() => void events.push("up2"),
		() => void events.push("down2"),
	);

	assert.deepStrictEqual(await m.up(), 2);
	assert.deepStrictEqual(events, [
		"begin:up:1.0.0",
		"up1",
		"mark:1.0.0",
		"commit:1.0.0",
		"begin:up:2.0.0",
		"up2",
		"mark:2.0.0",
		"commit:2.0.0",
	]);

	events.length = 0;
	assert.deepStrictEqual(await m.uninstall(), 2);
	assert.deepStrictEqual(events, [
		"begin:down:2.0.0",
		"down2",
		"mark:1.0.0",
		"commit:1.0.0",
		"begin:down:1.0.0",
		"down1",
		"mark:undefined",
		"commit:undefined",
	]);
});

test("wrapStep cannot turn a failed or skipped step into a success", async () => {
	const boom = () => {
		throw new Error("boom");
	};

	// the hook sees the failure (so it can roll back), and swallowing it changes nothing
	let rolledBack = 0;
	const swallowing = new Migrate({
		wrapStep: async (run) => {
			try {
				await run();
			} catch {
				rolledBack++;
			}
		},
	});
	swallowing.addVersion("1", noop, noop);
	swallowing.addVersion("2", boom, noop);
	await assert.rejects(
		() => swallowing.up(),
		/The upgrade to version "2\.0\.0" failed/,
	);
	assert.deepStrictEqual(rolledBack, 1);
	assert.deepStrictEqual(await swallowing.getActiveVersion(), "1.0.0");

	// a hook that never runs the step
	let ran = 0;
	const skipping = new Migrate({ wrapStep: async () => {} });
	skipping.addVersion("1", () => void ran++, noop);
	await assert.rejects(() => skipping.up(), /without calling and awaiting run\(\)/);
	assert.deepStrictEqual(ran, 0);
	assert.deepStrictEqual(await skipping.getActiveVersion(), undefined);

	// a hook that runs it twice
	const twice = new Migrate({
		wrapStep: async (run) => {
			await run();
			await run();
		},
	});
	twice.addVersion("1", () => void ran++, noop);
	await assert.rejects(() => twice.up(), /must call run\(\) exactly once/);
	assert.deepStrictEqual(ran, 1);
});

test("a step fails when wrapStep throws after run()", async () => {
	const commitError = new Error("commit failed");
	const m = new Migrate({
		wrapStep: async (run) => {
			await run();
			throw commitError;
		},
	});
	m.addVersion("1", noop, noop);

	await assert.rejects(
		() => m.up(),
		(e: Error) => {
			assert.match(
				e.message,
				/The "wrapStep" hook failed after the up step of version "1\.0\.0" completed/,
			);
			assert.strictEqual(e.cause, commitError);
			return true;
		},
	);

	// the in-memory marker is back where it was before the step
	assert.deepStrictEqual(await m.getActiveVersion(), undefined);
});

test("wrapRun wraps the whole operation, reading the active version included", async () => {
	const events: string[] = [];
	let stored: string | undefined;

	const m = new Migrate({
		getActiveVersion: () => {
			events.push("read");
			return stored;
		},
		setActiveVersion: (v) => {
			stored = v;
		},
		wrapRun: async (run, info) => {
			events.push(`lock:${info.operation}:${info.target}`);
			await run();
			events.push("unlock");
		},
	});
	m.addVersion("1", noop, noop);
	m.addVersion("2", noop, noop);

	assert.deepStrictEqual(await m.up(), 2);
	assert.deepStrictEqual(events.at(0), "lock:up:latest");
	assert.deepStrictEqual(events.at(-1), "unlock");
	assert.ok(events.includes("read"));
	assert.deepStrictEqual(events.filter((e) => e !== "read").length, 2);

	events.length = 0;
	assert.deepStrictEqual(await m.down(), 1);
	assert.deepStrictEqual(events.at(0), "lock:down:major");
	assert.deepStrictEqual(events.at(-1), "unlock");

	events.length = 0;
	assert.deepStrictEqual(await m.uninstall(), 1);
	assert.deepStrictEqual(events.at(0), "lock:uninstall:undefined");
	assert.deepStrictEqual(events.at(-1), "unlock");

	// a hook that never runs the operation is an error, not "0 steps"
	const skipping = new Migrate({ wrapRun: async () => {} });
	skipping.addVersion("1", noop, noop);
	await assert.rejects(() => skipping.up(), /without calling and awaiting run\(\)/);
	assert.deepStrictEqual(await skipping.getActiveVersion(), undefined);
});

test("removeVersion", async () => {
	const m = new Migrate();
	const v1 = m.addVersion("1", noop, noop);
	m.addVersion("2", noop, noop);
	m.addVersion("3", noop, noop);
	await m.setActiveVersion("2");

	// not registered
	assert.deepStrictEqual(await m.removeVersion("9.9.9"), false);

	// the active version stays: removing it would orphan the marker
	await assert.rejects(() => m.removeVersion("v2"), /Cannot remove the active version/);
	assert.deepStrictEqual(m.available, ["1.0.0", "2.0.0", "3.0.0"]);

	// above the active one (a pending version)...
	assert.deepStrictEqual(await m.removeVersion("3"), true);
	assert.deepStrictEqual(m.available, ["1.0.0", "2.0.0"]);
	assert.deepStrictEqual((await m.status()).isAtLatest, true);

	// ...and below it (by instance): the active version is untouched
	assert.deepStrictEqual(await m.removeVersion(v1), true);
	assert.deepStrictEqual(m.available, ["2.0.0"]);
	assert.deepStrictEqual(await m.getActiveVersion(), "2.0.0");
	assert.deepStrictEqual(await m.uninstall(), 1);
});

test("errors keep the original error as their cause", async () => {
	class DbError extends Error {
		code = "42P07";
	}
	const original = new DbError("relation already exists");
	const boom = () => {
		throw original;
	};

	// the up worker
	const up = new Migrate();
	up.addVersion("1", boom, noop);
	await assert.rejects(
		() => up.up(),
		(e: Error) => {
			assert.match(e.message, /The upgrade to version "1\.0\.0" failed/);
			assert.strictEqual(e.cause, original);
			return true;
		},
	);

	// the down worker
	const down = new Migrate();
	down.addVersion("1", noop, noop);
	down.addVersion("2", noop, boom);
	await down.up();
	await assert.rejects(
		() => down.down(),
		(e: Error) => {
			assert.match(e.message, /The downgrade from version "2\.0\.0" failed/);
			assert.strictEqual(e.cause, original);
			return true;
		},
	);
	assert.deepStrictEqual(await down.getActiveVersion(), "2.0.0");

	// the marker write
	let stored: string | undefined;
	const marker = new Migrate({
		getActiveVersion: () => stored,
		setActiveVersion: boom,
	});
	marker.addVersion("1", noop, noop);
	await assert.rejects(
		() => marker.up(),
		(e: Error) => {
			assert.match(e.message, /succeeded, but was unable to save/);
			assert.strictEqual(e.cause, original);
			return true;
		},
	);
	assert.deepStrictEqual(stored, undefined);
});

test("getActiveVersion and setActiveVersion must come together", () => {
	assert.throws(
		() => new Migrate({ getActiveVersion: () => undefined }),
		/must be provided together/,
	);
	assert.throws(
		() => new Migrate({ setActiveVersion: () => {} }),
		/must be provided together/,
	);
	// neither, or both, is fine
	new Migrate();
	new Migrate({ getActiveVersion: () => undefined, setActiveVersion: () => {} });
});

test("a failed external write leaves the in-memory active version alone", async () => {
	let stored: string | undefined;
	let fail = false;
	const m = new Migrate({
		getActiveVersion: () => stored,
		setActiveVersion: (v) => {
			if (fail) throw new Error("write failed");
			stored = v;
		},
	});
	m.addVersion("1", noop, noop);
	m.addVersion("2", noop, noop);

	await m.setActiveVersion("1");
	assert.deepStrictEqual(m.__versions.active?.version, "1.0.0");

	fail = true;
	await assert.rejects(() => m.setActiveVersion("2"), /write failed/);
	assert.deepStrictEqual(m.__versions.active?.version, "1.0.0");
	await assert.rejects(() => m.forceSetActiveVersion("2"), /write failed/);
	assert.deepStrictEqual(m.__versions.active?.version, "1.0.0");
});

test("status() with an active version unknown to the registry", async () => {
	let stored: string | undefined = "9.0.0";
	const m = new Migrate({
		getActiveVersion: () => stored,
		setActiveVersion: (v) => {
			stored = v;
		},
	});
	m.addVersion("1", noop, noop);
	m.addVersion("2", noop, noop);

	// above everything registered: nothing is pending (and nothing can run)
	assert.deepStrictEqual(await m.status(), {
		active: "9.0.0",
		latest: "2.0.0",
		isAtLatest: false,
		pending: [],
	});
	await assert.rejects(() => m.up(), /Version not found/);

	// between registered versions: only the ones above it are pending
	stored = "1.5.0";
	assert.deepStrictEqual((await m.status()).pending, ["2.0.0"]);
});

// Mostly a compile-time test: `pnpm run typecheck` is what checks the context types.
test("the context is typed, from the constructor argument", async () => {
	const context = { applied: [] as string[] };
	let stored: string | null = null;

	const m = new Migrate(
		{
			// sync or async, and `null` is as good as `undefined`
			getActiveVersion: (ctx) => {
				ctx.applied satisfies string[];
				return stored;
			},
			setActiveVersion: (version, ctx) => {
				ctx.applied satisfies string[];
				stored = version ?? null;
			},
		},
		context,
	);

	// workers may return anything (here: what push/pop return)
	m.addVersion(
		"1",
		(ctx) => ctx.applied.push("one"),
		(ctx) => ctx.applied.pop(),
	);
	m.addVersion(
		"2",
		async (ctx) => ctx.applied.push("two"),
		async (ctx) => ctx.applied.pop(),
	);

	// @ts-expect-error the context has no such property
	m.addVersion("3", (ctx) => ctx.nope);
	await m.removeVersion("3");

	assert.deepStrictEqual(await m.up(), 2);
	assert.deepStrictEqual(context.applied, ["one", "two"]);
	assert.deepStrictEqual(stored, "2.0.0");

	assert.deepStrictEqual(await m.uninstall(), 2);
	assert.deepStrictEqual(context.applied, []);
	assert.deepStrictEqual(stored, null);

	// a bare `Migrate` accepts an instance of any context
	const any: Migrate = m;
	assert.strictEqual(any.context, context);
});
