import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Migrate, MigrateFn } from "../src/mod.ts";
import { createPgMigrate } from "../src/pg.ts";
import { type Context, pool } from "./_db.ts";

const _dirname = basename(import.meta.dirname);
const _basename = basename(import.meta.filename);

/** Main runner */
export async function main() {
	const { values: flags } = parseArgs({
		args: process.argv.slice(2),
		options: {
			help: { type: "boolean", short: "h" },
			up: { type: "boolean" },
			down: { type: "boolean" },
			verbose: { type: "boolean" },
			uninstall: { type: "boolean" },
			target: { type: "string" },
		},
	});

	const showHelp = flags.help;
	const updown = (flags.up || flags.down) && flags.target;
	const uninstall = flags.uninstall;

	if (showHelp || !(updown || uninstall)) {
		return console.log(
			`\nUsage:
    node --env-file=.env ${_dirname}/${_basename} [--up|--down] --target=target [--verbose]
    node --env-file=.env ${_dirname}/${_basename} --uninstall [--verbose]
`,
		);
	}

	// The helper owns the database side: the `__migrate__` version table, one
	// connection per run, one run at a time across processes, one transaction per step
	const migrate = createPgMigrate(pool, {
		logger: flags.verbose ? console.debug : undefined,
	});

	await add_versions(migrate);

	//
	let res: number;
	if (uninstall) {
		res = await migrate.uninstall();
	} else {
		res = await migrate[flags.up ? "up" : "down"](flags.target);
	}

	console.log("OK", res);
}

/**
 * Internal dir walker: every `<semver>/migrate.ts` next to this file is a version.
 *
 * A version that cannot be loaded stops the run. Skipping it instead would let the
 * active version move past it, and a version below the active one is never applied
 * afterwards.
 */
async function add_versions(migrate: Migrate<Context>, dir = import.meta.dirname) {
	for (const dirEntry of readdirSync(dir, { withFileTypes: true })) {
		const version = dirEntry.name;
		if (!dirEntry.isDirectory() || !/^v?\d+\.\d+\.\d+(-.+)?$/.test(version)) {
			continue;
		}

		const path = join(dir, version, "migrate.ts");
		if (!existsSync(path)) {
			throw new Error(`Version directory "${version}" has no migrate.ts`);
		}

		let module: Record<string, unknown>;
		try {
			module = await import(pathToFileURL(path).href);
		} catch (e) {
			throw new Error(`Unable to load "${version}/migrate.ts" (Details: ${e})`, {
				cause: e,
			});
		}

		// `down` is optional: a module without it is a one-way (irreversible) version
		const { up, down } = module;
		if (typeof up !== "function" || (down != null && typeof down !== "function")) {
			throw new Error(
				`Invalid version module "${version}/migrate.ts" (it must export "up" ` +
					`as a function, and "down" too unless the version is one-way)`,
			);
		}

		migrate.addVersion(
			version,
			up as MigrateFn<Context>,
			down as MigrateFn<Context> | undefined,
		);
	}
}

// run now...
if (import.meta.main) {
	try {
		await main();
		process.exit(0);
	} catch (e) {
		console.error(e);
		process.exit(1);
	}
}
