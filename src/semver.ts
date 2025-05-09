/**
 * MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]
 */

/**
 * Normalizes a version string to comply with semver format (MAJOR.MINOR.PATCH)
 */
export function normalizeSemver(version: string, assert = true) {
	// Remove leading 'v' or 'V' if present
	if (/^v/i.test(version)) {
		version = version.substring(1);
	}

	// First, handle the case where there's a prerelease or build info without dots
	// Example: "7-rc.1" should be treated as "7.0.0-rc.1"
	const fullMatch = version.match(
		/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+?))?(?:\+(.+))?$/
	);

	if (fullMatch) {
		// We have a version that might be missing minor/patch but has correct format
		const major = fullMatch[1] || "0";
		const minor = fullMatch[2] || "0";
		const patch = fullMatch[3] || "0";
		const prerelease = fullMatch[4] ? `-${fullMatch[4]}` : "";
		const build = fullMatch[5] ? `+${fullMatch[5]}` : "";

		return `${major}.${minor}.${patch}${prerelease}${build}`;
	}

	// Handle the case where hyphen might be used incorrectly
	// Example: "7-rc.1" (where hyphen is used instead of dots for version parts)
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

	// Maybe assert valid format
	if (assert) {
		throw new TypeError(`Invalid version "${version}"`);
	}

	// Otherwise return a minimal valid version
	return "0.0.0";
}

/**
 * Parse semver components: major.minor.patch(-prerelease)(+build)
 */
export function parseSemver(version: string) {
	version = normalizeSemver(version);
	const match = version.match(
		/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/
	);
	if (!match) {
		throw new Error(`Invalid semver ${version}`);
	}

	return {
		major: parseInt(match[1], 10),
		minor: parseInt(match[2], 10),
		patch: parseInt(match[3], 10),
		prerelease: match[4] || "",
		build: match[5] || "", // Build metadata should be ignored when determining version precedence
	};
}

/**
 * Compares semver strings (suitable for sorting).
 */
export function compareSemver(a: string, b: string) {
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
			}
			// Non-numeric identifiers are compared lexically (ASCII)
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
