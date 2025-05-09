import { walkSync } from "@std/fs";
import { basename, dirname, join } from "@std/path";
import { parseArgs } from "@std/cli";
import { Migrate } from "../src/mod.ts";
import { getActiveVersion, setActiveVersion, pool } from "./_db.ts";

const _dirname = basename(dirname(import.meta.filename!));
const _basename = basename(import.meta.filename!);

/** Main runner */
export async function main() {
	const flags = parseArgs(Deno.args, {
		boolean: ["help", "h", "up", "down", "verbose", "uninstall"],
		string: ["target"],
	});
	// console.log(flags, flags.up || flags.down || flags.uninstall);

	const showHelp = flags.help || flags.h;
	const updown = (flags.up || flags.down) && flags.target;
	const uninstall = flags.uninstall;

	if (showHelp || !(updown || uninstall)) {
		return console.log(
			`\n    deno run -A ${_dirname}/${_basename} [--up|--down] --target=target [--verbose]\n`
		);
	}

	const migrate = new Migrate(
		// options
		{
			setActiveVersion,
			getActiveVersion,
			logger: flags.verbose ? console.debug : undefined,
		},
		{ pool } // context
	);

	await add_versions(migrate);

	//
	if (uninstall) {
		return await migrate.uninstall();
	} else {
		return await migrate[flags.up ? "up" : "down"](flags.target);
	}
}

/** Internal dir walker */
async function add_versions(
	migrate: Migrate,
	dir = join(Deno.cwd(), "./example/migrations")
) {
	for (const dirEntry of walkSync(dir, {
		maxDepth: 2,
		match: [/migrate\.ts$/],
	})) {
		const version = basename(dirname(dirEntry.path));
		try {
			const { up, down } = await import(dirEntry.path);

			if (typeof up !== "function" || typeof down !== "function") {
				throw new Error(
					`Invalid version module for ${version} ` +
						`(must export both "up" and "down" as functions)`
				);
			}

			migrate.addVersion(version, up, down);
		} catch (e) {
			console.warn(`Skipped ${version}... (Details: ${e})`);
		}
	}
}

// run now...
if (import.meta.main) {
	try {
		const res = await main();
		console.log(`OK`, res);
		Deno.exit(0);
	} catch (e) {
		console.error(e);
		Deno.exit(1);
	}
}
