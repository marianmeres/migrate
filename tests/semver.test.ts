// deno-lint-ignore-file no-explicit-any

import { assertEquals } from "@std/assert";
import { compareSemver, normalizeSemver, parseSemver } from "../src/semver.ts";

function shuffle(array: any[]): any[] {
	return array.toSorted(() => Math.random() - 0.5);
}

Deno.test("semver normalize", () => {
	// prettier-ignore
	const toBeNormalizedVersions = {
        "1": "1.0.0",
        "v2": "2.0.0",
        "3.1": "3.1.0",
        "4.2.1": "4.2.1",
        "5.0.0-alpha": "5.0.0-alpha",
        "6.0-beta": "6.0.0-beta",
        "7-rc.1": "7.0.0-rc.1",
        "8.1.0+build.123": "8.1.0+build.123",
        "9.2-alpha+build.456": "9.2.0-alpha+build.456",
        "v10": "10.0.0",
        "11.0.0-beta.1+exp.sha.5114f85": "11.0.0-beta.1+exp.sha.5114f85",
		"1-foo": "1.0.0-foo",
		"20250501": "20250501.0.0",
		"2025-05-01.foo": "2025.0.0-05-01.foo",
    };

	Object.entries(toBeNormalizedVersions).forEach(([version, normalized]) => {
		assertEquals(normalizeSemver(version), normalized);
	});
});

Deno.test("semver parse", () => {
	// prettier-ignore
	const versions = {
        "1.0.0": { major: 1, minor: 0, patch: 0, prerelease: "", build: "" },
        "2.0.0": { major: 2, minor: 0, patch: 0, prerelease: "", build: "" },
        "1.10.0": { major: 1, minor: 10, patch: 0, prerelease: "", build: "" },
        "1.2.0": { major: 1, minor: 2, patch: 0, prerelease: "", build: "" },
        "1.1.0-alpha.1": { major: 1, minor: 1, patch: 0, prerelease: "alpha.1", build: "" },
        "1.1.0-alpha": { major: 1, minor: 1, patch: 0, prerelease: "alpha", build: "" },
        "1.1.0": { major: 1, minor: 1, patch: 0, prerelease: "", build: "" },
        "1.1.0+build.123": { major: 1, minor: 1, patch: 0, prerelease: "", build: "build.123" },
        "1.0.0-beta": { major: 1, minor: 0, patch: 0, prerelease: "beta", build: "" },
        "1.0.0-alpha.beta": { major: 1, minor: 0, patch: 0, prerelease: "alpha.beta", build: "" },
        "1.0.0-alpha.1": { major: 1, minor: 0, patch: 0, prerelease: "alpha.1", build: "" },
    };

	Object.entries(versions).forEach(([version, parsed]) => {
		assertEquals(parseSemver(version), parsed);
	});
});

Deno.test("semver compare", () => {
	const map: Record<string, number> = {
		"1.0.0-alpha.1": 0,
		"1.0.0-alpha.beta": 1,
		"1.0.0-beta": 2,
		"1.0.0": 3,
		"1.1.0-alpha": 4,
		"1.1.0-alpha.1": 5,
		"1.1.0": 6,
		"1.1.0+build.123": 7,
		"1.2.0": 8,
		"1.10.0": 9,
		"2.0.0": 10,
	};

	const sorted = shuffle(Object.keys(map)).toSorted(compareSemver);

	assertEquals(sorted.map((v) => map[v]).join(","), "0,1,2,3,4,5,6,7,8,9,10");
});
