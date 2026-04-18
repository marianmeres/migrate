import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Migrate, type MigrateOptions, Version } from "../src/migrate.ts";

const clog = console.log;
const noop = (_c: any) => Promise.resolve();

function create_migrate(
	options: Partial<MigrateOptions> = {},
	versionsCount = 4,
) {
	const log: any[] = ["clean"]; // just some marker

	// simulate external version store
	let version: string | undefined = undefined;

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
		setActiveVersion: (v: string | undefined, _ctx) => Promise.resolve(version = v),
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

Deno.test("version is semver normalized", () => {
	const v = new Version("1.2-foo+bar", noop, noop, "foo");
	assertEquals(v.version, "1.2.0-foo+bar");
	assertEquals(v.major, 1);
	assertEquals(v.minor, 2);
	assertEquals(v.patch, 0);
	assertEquals(v.prerelease, "foo");
	assertEquals(v.build, "bar");
	assertEquals(v.comment, "foo");
});

Deno.test("sanity check", async () => {
	const m = new Migrate();
	["v4", "v1", "v2", "3.5", "v3.5.0-foo"].forEach((v) => m.addVersion(v, noop, noop));

	assertEquals(m.available, ["1.0.0", "2.0.0", "3.5.0-foo", "3.5.0", "4.0.0"]);

	// current version must be undefined
	const v = await m.getActiveVersion();
	assertEquals(v, undefined);

	// adding the same must fail
	assertThrows(() => m.addVersion("v1", noop, noop));

	// indexOf
	assertEquals(m.indexOf("v2"), 1);
	assertEquals(m.indexOf("v2.0"), 1);
	assertEquals(m.indexOf("v2.0.0"), 1);
	assertEquals(m.indexOf("9.8.7"), -1);

	// search works
	assertEquals(
		m.__versions
			.search("3.", "prefix")
			.toSorted(m.compareFn)
			.map((i) => i.version),
		["3.5.0-foo", "3.5.0"],
	);

	//
	assertEquals(await m.setActiveVersion("latest"), "4.0.0");
	assertEquals(await m.setActiveVersion("initial"), "1.0.0");

	// set nonexisting must throw
	assertRejects(() => m.setActiveVersion("7.8.9"));
});

Deno.test("single first version", async () => {
	const { migrate: m, getLog } = create_migrate(
		{
			// logger: clog,
		},
		1,
	);

	// we only have 1 version
	assertEquals(m.versions.length, 1);
	assertEquals(await m.getActiveVersion(), undefined);
	assertEquals(await m.up("latest"), 1);
	assertEquals(await m.getActiveVersion(), "1.0.0");
});

Deno.test("up/down meta", async () => {
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

	assertEquals(await m.__upMeta("patch"), {
		fromVersion: "1.0.0",
		fromIndex: 0,
		toVersion: "1.0.2",
		toIndex: 2,
		isInitial: true, // because internal version is undefined
	});

	assertEquals(await m.__upMeta("minor"), {
		fromVersion: "1.0.0",
		fromIndex: 0,
		toVersion: "1.2.2",
		toIndex: 6,
		isInitial: true, // because internal version is undefined
	});

	assertEquals((await m.__upMeta("major"))?.toVersion, "2.0.0");
	assertEquals((await m.__upMeta("latest"))?.toVersion, "10.11.12");

	await m.setActiveVersion("4");
	assertEquals(await m.getActiveVersion(), "4.0.0");

	assertEquals(await m.__upMeta("patch"), {
		fromVersion: "4.0.0",
		fromIndex: 9,
		toVersion: "4.0.0",
		toIndex: 9,
		isInitial: false, // because internal version IS defined already
	});

	assertEquals(await m.__upMeta("minor"), {
		fromVersion: "4.0.0",
		fromIndex: 9,
		toVersion: "4.0.0",
		toIndex: 9,
		isInitial: false,
	});

	// this must find the next after the gap, but not the latest
	assertEquals(await m.__upMeta("major"), {
		fromVersion: "4.0.0",
		fromIndex: m.available.indexOf("4.0.0"),
		toVersion: "7.8.9",
		toIndex: m.available.indexOf("7.8.9"),
		isInitial: false,
	});

	//
	assertEquals(await m.__upMeta("123.456.789"), {
		fromVersion: "4.0.0",
		fromIndex: m.available.indexOf("4.0.0"),
		toVersion: undefined,
		toIndex: -1,
		isInitial: false,
	});

	// clog(m.available, await m.getActiveVersion());

	assertEquals(await m.__downMeta("major"), {
		fromVersion: "4.0.0",
		fromIndex: m.available.indexOf("4.0.0"),
		toVersion: "3.0.0",
		toIndex: m.available.indexOf("3.0.0"),
	});

	assertEquals(await m.__downMeta("1.2.2"), {
		fromVersion: "4.0.0",
		fromIndex: m.available.indexOf("4.0.0"),
		toVersion: "1.2.2",
		toIndex: m.available.indexOf("1.2.2"),
	});

	await m.setActiveVersion("1.2.2");

	assertEquals(await m.__downMeta("patch"), {
		fromVersion: "1.2.2",
		fromIndex: m.available.indexOf("1.2.2"),
		toVersion: "1.2.1",
		toIndex: m.available.indexOf("1.2.1"),
	});

	assertEquals(await m.__downMeta("minor"), {
		fromVersion: "1.2.2",
		fromIndex: m.available.indexOf("1.2.2"),
		toVersion: "1.1.0",
		toIndex: m.available.indexOf("1.1.0"),
	});

	// not existing
	assertEquals(await m.__upMeta("123.456.789"), {
		fromVersion: "1.2.2",
		fromIndex: m.available.indexOf("1.2.2"),
		toVersion: undefined,
		toIndex: -1,
		isInitial: false,
	});

	assertEquals(await m.__downMeta("0.0.456"), {
		fromVersion: "1.2.2",
		fromIndex: 6,
		toVersion: undefined,
		toIndex: -1,
	});
});

Deno.test("up down", async () => {
	const { migrate: m, getLog } = create_migrate({
		// logger: clog,
	});
	assertEquals(await m.getActiveVersion(), undefined);
	assertEquals(m.available, ["1.0.0", "2.0.0", "3.0.0", "4.0.0"]);

	// down from undef throws
	assertRejects(() => m.__downMeta("initial"));

	// up latest
	assertEquals(await m.up("latest"), 4); // "4" because initial
	assertEquals(await m.getActiveVersion(), "4.0.0");
	assertEquals(getLog(), ["clean", "a", "b", "c", "d"]);

	// down to initial (note, that this does not remove completely)
	assertEquals(await m.down("initial"), 3);
	assertEquals(await m.getActiveVersion(), "1.0.0");
	assertEquals(getLog(), ["clean", "a"]); //

	// back to latest
	assertEquals(await m.up("latest"), 3); // not 4 as above, because we're already at 1.0.0
	assertEquals(await m.getActiveVersion(), "4.0.0");
	assertEquals(getLog(), ["clean", "a", "b", "c", "d"]);

	// down to 2
	assertEquals(await m.down("v2"), 2);
	assertEquals(await m.getActiveVersion(), "2.0.0");
	assertEquals(getLog(), ["clean", "a", "b"]);

	// up to 3 (defined as next major)
	assertEquals(await m.up("major"), 1);
	assertEquals(await m.getActiveVersion(), "3.0.0");
	assertEquals(getLog(), ["clean", "a", "b", "c"]);

	// back to latest
	assertEquals(await m.up("latest"), 1);
	assertEquals(await m.getActiveVersion(), "4.0.0");
	assertEquals(getLog(), ["clean", "a", "b", "c", "d"]);

	// now remove altogether
	assertEquals(await m.uninstall(), 4);
	assertEquals(await m.getActiveVersion(), undefined);
	assertEquals(getLog(), ["clean"]); //

	// this will be now a clean install
	assertEquals(await m.up(), 4);
	assertEquals(await m.getActiveVersion(), "4.0.0");
	assertEquals(getLog(), ["clean", "a", "b", "c", "d"]);
});

Deno.test("up('patch') bridges prerelease to release (H3)", async () => {
	const m = new Migrate();
	m.addVersion("1.0.0-alpha", noop, noop);
	m.addVersion("1.0.0", noop, noop);
	m.addVersion("1.0.1", noop, noop);
	m.addVersion("1.1.0", noop, noop);

	await m.setActiveVersion("1.0.0-alpha");

	// "patch" from a prerelease should reach the release (and its patch successors)
	const meta = await m.__upMeta("patch");
	assertEquals(meta?.toVersion, "1.0.1");

	// "minor" from a prerelease should reach into higher minor
	const minorMeta = await m.__upMeta("minor");
	assertEquals(minorMeta?.toVersion, "1.1.0");
});

Deno.test("down('patch') bridges release to prerelease (H3)", async () => {
	const m = new Migrate();
	m.addVersion("1.0.0-alpha", noop, noop);
	m.addVersion("1.0.0", noop, noop);

	await m.setActiveVersion("1.0.0");
	const meta = await m.__downMeta("patch");
	assertEquals(meta?.toVersion, "1.0.0-alpha");
});

Deno.test("cold-start syncs internal active from external getter (H4)", async () => {
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

	// Internal not synced yet
	assertEquals(m.__versions.active, undefined);
	// Reading through public API should sync internal state
	assertEquals(await m.getActiveVersion(), "2.0.0");
	assertEquals(m.__versions.active?.version, "2.0.0");

	// And it stays in sync when external changes
	externalVersion = "3.0.0";
	assertEquals(await m.getActiveVersion(), "3.0.0");
	assertEquals(m.__versions.active?.version, "3.0.0");

	// Undefined clears internal too
	externalVersion = undefined;
	assertEquals(await m.getActiveVersion(), undefined);
	assertEquals(m.__versions.active, undefined);
});

Deno.test("concurrent up() calls are serialized (M1)", async () => {
	const events: string[] = [];
	const slow = (tag: string, ms = 5) => () =>
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
	assertEquals(a, 2);
	assertEquals(b, 0);

	// No interleaving: every start is followed by its own end before next start
	for (let i = 0; i < events.length; i += 2) {
		const [startTag] = events[i].split("-").slice(1);
		const [endEvent, endTag] = events[i + 1].split("-");
		assertEquals(endEvent, "end");
		assertEquals(endTag, startTag);
	}
});

Deno.test("forceSetActiveVersion recovery helper (M2)", async () => {
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
	assertEquals(await m.forceSetActiveVersion("2.0.0"), "2.0.0");
	assertEquals(externalVersion, "2.0.0");
	assertEquals(m.__versions.active?.version, "2.0.0");

	// Force to a version unknown to the registry: external is still written,
	// internal active is cleared rather than inventing a ghost.
	assertEquals(await m.forceSetActiveVersion("9.9.9"), "9.9.9");
	assertEquals(externalVersion, "9.9.9");
	assertEquals(m.__versions.active, undefined);

	// Clear
	assertEquals(await m.forceSetActiveVersion(undefined), undefined);
	assertEquals(externalVersion, undefined);
});

Deno.test("irreversible migrations (M5)", async () => {
	const m = new Migrate();

	// null marks a one-way migration
	const v1 = m.addVersion("1.0.0", noop, noop);
	const v2 = m.addVersion("2.0.0", noop, null);
	const v3 = m.addVersion("3.0.0", noop, noop);

	assert(v1.isReversible);
	assert(!v2.isReversible);
	assert(v3.isReversible);

	await m.up("latest");
	assertEquals(await m.getActiveVersion(), "3.0.0");

	// Down from 3.0.0 to 2.0.0 works (calls v3.down)
	await m.down(); // major: from 3 to 2
	assertEquals(await m.getActiveVersion(), "2.0.0");

	// Further down-walk tries to call v2.down() which throws
	await assertRejects(() => m.down("initial"));

	// And uninstall on a one-way initial fails loudly too
	const m2 = new Migrate();
	m2.addVersion("1.0.0", noop, null);
	await m2.up("latest");
	await assertRejects(() => m2.uninstall());
});

Deno.test("up() does not mutate state when migration throws", async () => {
	const m = new Migrate();
	m.addVersion("1.0.0", noop, noop);
	m.addVersion("2.0.0", () => {
		throw new Error("boom");
	}, noop);
	m.addVersion("3.0.0", noop, noop);

	await assertRejects(() => m.up("latest"));
	// We got to 1.0.0, failed on 2.0.0 - active should be 1.0.0, not 2.0.0
	assertEquals(await m.getActiveVersion(), "1.0.0");
});

Deno.test("plan() produces steps without mutating state", async () => {
	const m = new Migrate();
	m.addVersion("1.0.0", noop, noop);
	m.addVersion("2.0.0", noop, noop);
	m.addVersion("3.0.0", noop, noop);

	const upPlan = await m.plan("up", "latest");
	assertEquals(upPlan.direction, "up");
	assertEquals(upPlan.fromVersion, undefined);
	assertEquals(upPlan.toVersion, "3.0.0");
	assertEquals(upPlan.steps.map((s) => s.version), ["1.0.0", "2.0.0", "3.0.0"]);
	// State is unchanged
	assertEquals(await m.getActiveVersion(), undefined);

	await m.up("latest");
	const downPlan = await m.plan("down", "initial");
	assertEquals(downPlan.direction, "down");
	assertEquals(downPlan.fromVersion, "3.0.0");
	assertEquals(downPlan.toVersion, "1.0.0");
	assertEquals(downPlan.steps.map((s) => s.version), ["3.0.0", "2.0.0"]);
	assertEquals(downPlan.steps.map((s) => s.activeAfter), ["2.0.0", "1.0.0"]);
});

Deno.test("status() reports pending migrations", async () => {
	const m = new Migrate();
	m.addVersion("1.0.0", noop, noop);
	m.addVersion("2.0.0", noop, noop);
	m.addVersion("3.0.0", noop, noop);

	let s = await m.status();
	assertEquals(s.active, undefined);
	assertEquals(s.latest, "3.0.0");
	assertEquals(s.isAtLatest, false);
	assertEquals(s.pending, ["1.0.0", "2.0.0", "3.0.0"]);

	await m.setActiveVersion("2.0.0");
	s = await m.status();
	assertEquals(s.active, "2.0.0");
	assertEquals(s.pending, ["3.0.0"]);
	assertEquals(s.isAtLatest, false);

	await m.setActiveVersion("3.0.0");
	s = await m.status();
	assertEquals(s.isAtLatest, true);
	assertEquals(s.pending, []);
});
