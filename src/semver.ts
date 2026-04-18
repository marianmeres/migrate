/**
 * @module
 * Semver utilities for parsing, normalizing, and comparing version strings.
 *
 * Version format: MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]
 *
 * @example
 * ```typescript
 * import { normalizeSemver, parseSemver, compareSemver } from "@marianmeres/migrate";
 *
 * normalizeSemver("v1.2");     // Returns "1.2.0"
 * normalizeSemver("7-rc.1");   // Returns "7.0.0-rc.1"
 *
 * parseSemver("1.2.3-alpha+build");
 * // Returns { major: 1, minor: 2, patch: 3, prerelease: "alpha", build: "build" }
 *
 * compareSemver("1.0.0", "2.0.0"); // Returns negative number
 * ```
 */

/**
 * Matches a semver-ish version string. MINOR and PATCH are optional and will
 * default to 0 on normalization. PRERELEASE and BUILD identifiers are
 * restricted to the semver-spec character set `[0-9A-Za-z-.]+`.
 */
const SEMVER_RE =
	/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/;

/**
 * Normalizes a version string to comply with semver format (MAJOR.MINOR.PATCH).
 * Prerelease and build identifiers must only contain `[0-9A-Za-z-.]` characters
 * as per the semver spec.
 * @param version - The version string to normalize (can include or omit 'v' prefix).
 * @param assert - If true (default), throws a TypeError for invalid version
 * strings. If false, returns `undefined` for invalid input.
 * @returns The normalized semver string, or `undefined` when `assert` is false
 * and the input is invalid.
 * @throws {TypeError} If assert is true and the version string is invalid.
 * @example
 * normalizeSemver("v1.2") // Returns "1.2.0"
 * normalizeSemver("7") // Returns "7.0.0"
 * normalizeSemver("1.2.3-rc.1+build.123") // Returns "1.2.3-rc.1+build.123"
 * normalizeSemver("nope", false) // Returns undefined
 */
export function normalizeSemver(version: string, assert?: true): string;
export function normalizeSemver(
	version: string,
	assert: false,
): string | undefined;
export function normalizeSemver(
	version: string,
	assert: boolean = true,
): string | undefined {
	if (typeof version !== "string") {
		if (assert) throw new TypeError(`Invalid version "${version}"`);
		return undefined;
	}

	// Remove leading 'v' or 'V' if present
	if (/^v/i.test(version)) {
		version = version.substring(1);
	}

	const match = version.match(SEMVER_RE);
	if (!match) {
		if (assert) throw new TypeError(`Invalid version "${version}"`);
		return undefined;
	}

	const major = match[1] || "0";
	const minor = match[2] || "0";
	const patch = match[3] || "0";
	const prerelease = match[4] ? `-${match[4]}` : "";
	const build = match[5] ? `+${match[5]}` : "";

	return `${major}.${minor}.${patch}${prerelease}${build}`;
}

/**
 * Parses a semver string into its component parts.
 * @param version - The version string to parse (will be normalized first).
 * @returns An object containing the parsed major, minor, patch, prerelease, and build components.
 * @throws {TypeError} If the version string is invalid.
 */
export function parseSemver(version: string): {
	major: number;
	minor: number;
	patch: number;
	prerelease: string;
	build: string;
} {
	const normalized = normalizeSemver(version);
	const match = normalized.match(SEMVER_RE)!;

	return {
		major: parseInt(match[1], 10),
		minor: parseInt(match[2] || "0", 10),
		patch: parseInt(match[3] || "0", 10),
		prerelease: match[4] || "",
		// Note: build metadata is ignored when determining version precedence
		build: match[5] || "",
	};
}

/**
 * Compares two semver strings according to semver precedence rules.
 * @param a - The first version string to compare.
 * @param b - The second version string to compare.
 * @returns A negative number if a < b, positive if a > b, or 0 if equal.
 * @example
 * compareSemver("1.0.0", "2.0.0") // Returns negative (1.0.0 < 2.0.0)
 * compareSemver("2.0.0", "1.0.0") // Returns positive (2.0.0 > 1.0.0)
 * compareSemver("1.0.0-alpha", "1.0.0") // Returns negative (prerelease < release)
 */
export function compareSemver(a: string, b: string): number {
	const vA = parseSemver(a);
	const vB = parseSemver(b);

	// Compare major, minor, patch
	if (vA.major !== vB.major) return vA.major - vB.major;
	if (vA.minor !== vB.minor) return vA.minor - vB.minor;
	if (vA.patch !== vB.patch) return vA.patch - vB.patch;

	// If we get here, major.minor.patch are equal
	// Pre-release versions have lower precedence than normal versions
	if (!vA.prerelease && vB.prerelease) return 1;
	if (vA.prerelease && !vB.prerelease) return -1;

	// Compare pre-release versions
	if (vA.prerelease && vB.prerelease) {
		const aParts = vA.prerelease.split(".");
		const bParts = vB.prerelease.split(".");

		for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
			// Missing parts have lower precedence
			if (i >= aParts.length) return -1;
			if (i >= bParts.length) return 1;

			const aIsNum = /^\d+$/.test(aParts[i]);
			const bIsNum = /^\d+$/.test(bParts[i]);

			// Numeric identifiers have lower precedence than non-numeric
			if (aIsNum && !bIsNum) return -1;
			if (!aIsNum && bIsNum) return 1;

			// Numeric identifiers are compared numerically
			if (aIsNum && bIsNum) {
				const diff = parseInt(aParts[i], 10) - parseInt(bParts[i], 10);
				if (diff !== 0) return diff;
			} // Non-numeric identifiers are compared lexically (ASCII)
			else if (aParts[i] !== bParts[i]) {
				return aParts[i] < bParts[i] ? -1 : 1;
			}
		}
	}

	// Versions are equal according to semver rules
	// For stable sorting, use the original string as a tiebreaker
	// This ensures that "1.1.0" and "1.1.0+build.123" always sort in a consistent order
	return a.localeCompare(b);
}
