import { z } from "npm:zod";
import type { McpToolDefinition } from "jsr:@marianmeres/mcp-server/types";
import { normalizeSemver, compareSemver } from "./src/mod.ts";

export const tools: McpToolDefinition[] = [
	{
		name: "normalize-semver",
		description:
			"Normalize a version string to full MAJOR.MINOR.PATCH semver format, preserving prerelease and build metadata. Handles v-prefix, missing segments, and shorthand versions.",
		params: {
			version: z
				.string()
				.describe("Version string to normalize (e.g., 'v1.2', '7', '1.0-rc.1')"),
		},
		handler: async ({ version }) => {
			return normalizeSemver(version as string);
		},
	},
	{
		name: "validate-semver",
		description:
			"Validate whether a string is a valid semver version that can be normalized. Returns the normalized form if valid.",
		params: {
			version: z.string().describe("Version string to validate"),
		},
		handler: async ({ version }) => {
			try {
				const normalized = normalizeSemver(version as string);
				return JSON.stringify({ valid: true, normalized });
			} catch (e) {
				return JSON.stringify({ valid: false, error: (e as Error).message });
			}
		},
	},
	{
		name: "compare-semver",
		description:
			"Compare two semver strings following official semver precedence rules (numeric comparison, prerelease precedence, build metadata ignored).",
		params: {
			a: z.string().describe("First version string"),
			b: z.string().describe("Second version string"),
		},
		handler: async ({ a, b }) => {
			const result = compareSemver(a as string, b as string);
			const relation = result < 0 ? "<" : result > 0 ? ">" : "==";
			return JSON.stringify({
				a,
				b,
				result,
				relation,
				description: `${a} ${relation} ${b}`,
			});
		},
	},
];
