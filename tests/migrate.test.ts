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
