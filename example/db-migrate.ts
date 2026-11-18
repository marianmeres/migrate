import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Migrate } from "../src/mod.ts";
import { getActiveVersion, pool, setActiveVersion } from "./_db.ts";

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

	const migrate = new Migrate(
		// options
		{
			setActiveVersion,
			getActiveVersion,
			logger: flags.verbose ? console.debug : undefined,
		},
		{ pool }, // context
	);

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

/** Internal dir walker: every `<semver>/migrate.ts` next to this file is a version */
async function add_versions(migrate: Migrate, dir = import.meta.dirname) {
	for (const dirEntry of readdirSync(dir, { withFileTypes: true })) {
		const version = dirEntry.name;
		const path = join(dir, version, "migrate.ts");
		if (
			!dirEntry.isDirectory() ||
			!/^v?\d+\.\d+\.\d+(-.+)?$/.test(version) ||
			!existsSync(path)
		) {
			continue;
		}
		try {
			const { up, down } = await import(pathToFileURL(path).href);

			if (typeof up !== "function" || typeof down !== "function") {
				throw new Error(
					`Invalid version module for ${version} ` +
						`(must export both "up" and "down" as functions)`,
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
		await main();
		process.exit(0);
	} catch (e) {
		console.error(e);
		process.exit(1);
	}
}
