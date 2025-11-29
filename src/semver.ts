/**
 * MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]
 */

/**
 * Normalizes a version string to comply with semver format (MAJOR.MINOR.PATCH).
 * @param version - The version string to normalize (can include or omit 'v' prefix).
 * @param assert - If true, throws an error for invalid version strings.
 * @returns The normalized semver string.
 * @throws {TypeError} If assert is true and the version string is invalid.
 * @example
 * normalizeSemver("v1.2") // Returns "1.2.0"
 * normalizeSemver("7") // Returns "7.0.0"
 * normalizeSemver("1.2.3-rc.1+build.123") // Returns "1.2.3-rc.1+build.123"
 */
export function normalizeSemver(version: string, assert = true): string {
	// Remove leading 'v' or 'V' if present
	if (/^v/i.test(version)) {
		version = version.substring(1);
	}

	// First, handle the case where there's prerelease or build info without dots
	// Example: "7-rc.1" should be treated as "7.0.0-rc.1"
	const fullMatch = version.match(
		/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+?))?(?:\+(.+))?$/,
	);

	if (fullMatch) {
		// We have a version that might be missing minor/patch but has the correct format
		const major = fullMatch[1] || "0";
		const minor = fullMatch[2] || "0";
		const patch = fullMatch[3] || "0";
		const prerelease = fullMatch[4] ? `-${fullMatch[4]}` : "";
		const build = fullMatch[5] ? `+${fullMatch[5]}` : "";

		return `${major}.${minor}.${patch}${prerelease}${build}`;
	}

	// Handle the case where a hyphen might be used incorrectly
	// Example: "7-rc.1" (where a hyphen is used instead of dots for version parts)
	const alternateMatch = version.match(/^(\d+)(?:-(.+))?$/);
	if (alternateMatch) {
		const major = alternateMatch[1];
		let prerelease = "";
		let build = "";

		if (alternateMatch[2]) {
			// Check if there's a build part in the second segment
			const buildSplit = alternateMatch[2].split("+");
			prerelease = `-${buildSplit[0]}`;
			if (buildSplit.length > 1) {
				build = `+${buildSplit[1]}`;
			}
		}

		return `${major}.0.0${prerelease}${build}`;
	}

	// Assert valid format if requested
	if (assert) {
		throw new TypeError(`Invalid version "${version}"`);
	}

	// Otherwise, return a minimal valid version
	return "0.0.0";
}

/**
 * Parses a semver string into its component parts.
 * @param version - The version string to parse (will be normalized first).
 * @returns An object containing the parsed major, minor, patch, prerelease, and build components.
 * @throws {Error} If the version string is invalid after normalization.
 */
export function parseSemver(version: string): {
	major: number;
	minor: number;
	patch: number;
	prerelease: string;
	build: string;
} {
	version = normalizeSemver(version);
	const match = version.match(
		/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/,
	);
	if (!match) {
		throw new Error(`Invalid semver ${version}`);
	}

	return {
		major: parseInt(match[1], 10),
		minor: parseInt(match[2], 10),
		patch: parseInt(match[3], 10),
		prerelease: match[4] || "",
		build: match[5] || "", // Note: Build metadata should be ignored when determining version precedence
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
