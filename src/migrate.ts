// deno-lint-ignore-file no-explicit-any

import { ItemCollection } from "@marianmeres/item-collection";
import { parseSemver } from "./mod.ts";
import { compareSemver, normalizeSemver } from "./semver.ts";

const clog = console.log;

/** The constructor options */
export interface MigrateOptions {
	/** Active version getter (eg reader from db). If not provided will read from memory. */
	getActiveVersion: (
		context: Record<string, unknown>
	) => Promise<string | undefined>;
	/** Active version setter (eg writer to db). If not provided will keep in memory */
	setActiveVersion: (
		version: string | undefined,
		context: Record<string, unknown>
	) => Promise<string | undefined>;
	/** Optional (debug) logger. */
	logger?: (...args: unknown[]) => void;
}

type MigrateFn = (context?: Record<string, unknown>) => void | Promise<void>;

/** Single version abstraction */
export class Version {
	/** The semver normalized version form. */
	public readonly version: string;
	/** Semver major segment parsed */
	public readonly major: number;
	/** Semver minor segment parsed */
	public readonly minor: number;
	/** Semver patch segment parsed */
	public readonly patch: number;
	/** Semver prerelease segment parsed */
	public readonly prerelease: string;
	/** Semver build segment parsed */
	public readonly build: string;

	#up: MigrateFn;

	#down: MigrateFn;

	constructor(
		version: string,
		up: MigrateFn,
		down: MigrateFn,
		public readonly comment: string | undefined = undefined,
		public logger?: (...args: any[]) => void
	) {
		if (!version || typeof up !== "function" || typeof down !== "function") {
			throw new TypeError("Invalid version parameters");
		}

		// Always keep normalized
		this.version = normalizeSemver(version);

		// Parse semver segments and store them individually (so we can query them easily)
		const { major, minor, patch, prerelease, build } = parseSemver(
			this.version
		);
		this.major = major;
		this.minor = minor;
		this.patch = patch;
		this.prerelease = prerelease;
		this.build = build;

		// Actual migrate workers
		this.#up = up;
		this.#down = down;
	}

	/** The upgrade worker */
	up(context: Parameters<MigrateFn>[0]): ReturnType<MigrateFn> {
		this.logger?.(`[${this.version}] up worker ...`);
		return this.#up(context);
	}

	/** The downgrade worker */
	down(context: Parameters<MigrateFn>[0]): ReturnType<MigrateFn> {
		this.logger?.(`[${this.version}] down worker ...`);
		this.#down(context);
	}

	/** Cast to string */
	toString(): string {
		return this.version;
	}
}

/** The migrate manager */
export class Migrate {
	/** Item collection's sort fn (which is compareSemver wrap) */
	#compareFn = (a: Version, b: Version) => compareSemver(a.version, b.version);

	/** Internal core collection of Version instances */
	#versions = new ItemCollection<Version>([], {
		idPropName: "version",
		sortFn: this.#compareFn,
		searchable: {
			getContent: (v) => {
				// remove dots from comment since we're using it in non-word whitelist
				// (so it doesn't pollute the index)
				return `${v.version} ${(v.comment || "").replaceAll(".", " ")}`;
			},
			nonWordCharWhitelist: ".",
			index: "trie",
		},
		unique: true,
	});

	/** Migrate options. */
	#options: Partial<MigrateOptions> = {};

	constructor(
		options: Partial<MigrateOptions> = {},
		/** Arbitrary context object passed to each up/down migration */
		public context: Record<string, any> = {}
	) {
		this.#options = { ...this.#options, ...options };
	}

	/** Internal debug logger */
	#log(...args: any[]) {
		args = [`[${new Date().toISOString()}] [migrate]`, ...args];
		this.#options?.logger?.(...args);
		return args[1];
	}

	/** Get the internal collection instance for debugging (or advanced hackings). */
	get __versions(): ItemCollection<Version> {
		return this.#versions;
	}

	/** Will get the internal collection of Version instances as array */
	get versions(): Version[] {
		return this.#versions.items;
	}

	/** Will get list of all available version strings. */
	get available(): string[] {
		return this.#versions.items.map((v) => v.version);
	}

	/** Access to internal sort fn, so it can be reused from the outside if needed. */
	get compareFn(): (a: Version, b: Version) => number {
		return this.#compareFn;
	}

	/** Will add a new version to internal collection. */
	addVersion(
		version: string,
		up: MigrateFn,
		down: MigrateFn,
		comment: string | undefined = undefined
	): Version {
		//
		const _version = new Version(version, up, down, comment, (...args) =>
			this.#log(...args)
		);

		// the internal collection does not assert... but we want to be strict here
		if (this.__versions.findById(_version.version)) {
			throw new Error(`Version already exists ("${version}")`);
		}

		this.#versions.add(_version);

		return _version;
	}

	/** Will read active version string. */
	async getActiveVersion(): Promise<string | undefined> {
		// Maybe read from external system
		if (typeof this.#options.getActiveVersion === "function") {
			let version = await this.#options?.getActiveVersion?.(this.context);
			if (version) version = normalizeSemver(version);
			return version ?? undefined; // explicit undef rather than null
		} else {
			return this.#versions.active?.version;
		}
	}

	/** Will set current version string and return it. */
	async setActiveVersion(
		version: "latest" | "initial" | undefined | string | Version
	): Promise<string | undefined> {
		// special case, undefined (marking the system as "uninstalled")
		if (version === undefined) {
			this.#versions.unsetActive();
		}
		// we have provided a version
		else {
			let _version: string;

			if (version instanceof Version) {
				_version = version.version;
			} else if (version === "latest") {
				_version = this.available.at(-1)!;
			} else if (version === "initial") {
				_version = this.available.at(0)!;
			} else {
				_version = normalizeSemver(version);
			}

			// provided defined version must exist
			let active;
			if (!_version || !(active = this.#versions.findById(_version))) {
				throw new Error(`Version not found ("${version}")`);
			}

			// sync to instance
			active ? this.#versions.setActive(active) : this.#versions.unsetActive();
		}

		const active = this.#versions.active?.version;

		// Maybe save in external system as well
		await this.#options.setActiveVersion?.(active, this.context);
		this.#log("setActiveVersion:", active);

		return active;
	}

	/** Will return the index of version in internal store. */
	indexOf(version: string): number {
		version = normalizeSemver(version);
		return this.#versions.findIndexBy("version", version);
	}

	/** Will find the version instance */
	findVersion(version: string, assert = false): Version | undefined {
		const index = this.indexOf(version);
		const out = index > -1 ? this.#versions.at(index) : undefined;
		if (assert && !out) {
			throw new Error(`Version not found ("${version}")`);
		}
		return out;
	}

	/**
	 * Helper to search for the matching up version and related info.
	 * Up is "greedy" and tries to go forward as much as possible (within constraints).
	 */
	async __upMeta(
		target: "latest" | "major" | "minor" | "patch" | string = "latest",
		fromVersionLabel?: string | undefined
	): Promise<
		| {
				toVersion: string | undefined;
				toIndex: number;
				fromVersion: string;
				fromIndex: number;
				isInitial: boolean;
		  }
		| undefined
	> {
		// no versions, nothing to do...
		if (!this.#versions.size) return undefined;

		fromVersionLabel ??= await this.getActiveVersion();
		const isInitial = fromVersionLabel === undefined;
		const from = fromVersionLabel
			? await this.findVersion(fromVersionLabel, true)!
			: this.#versions.at(0)!;

		// this is unexpected... getActiveVersion() must have returned unknown version
		if (!from) {
			throw new Error(`Version not found ("${fromVersionLabel}")?!?`);
		}

		//
		let toVersion: string | undefined;

		//
		if (target === "latest") {
			toVersion = this.#versions.at(-1)!.version;
		}
		//
		else if (target === "major") {
			// 2 steps
			const nextMajor = this.#versions.items
				.filter((v) => v.major > from.major)
				.at(0);

			if (nextMajor) {
				toVersion = this.#versions.items
					.filter((v) => v.major === nextMajor.major)
					.map((v) => v.version)
					.at(-1);
			}
			toVersion ??= from.version;
		}
		//
		else if (target === "minor") {
			toVersion =
				this.#versions.items
					.filter((v) => v.major === from.major && v.minor > from.minor)
					.map((v) => v.version)
					.at(-1) ?? from.version;
		}
		//
		else if (target === "patch") {
			toVersion =
				this.#versions.items
					.filter(
						(v) =>
							v.major === from.major &&
							v.minor === from.minor &&
							v.patch > from.patch
					)
					.map((v) => v.version)
					.at(-1) ?? from.version;
		}
		//
		else {
			toVersion = this.findVersion(target)?.version;
		}

		return {
			fromVersion: from.version,
			fromIndex: this.indexOf(from.version),
			toVersion,
			toIndex: toVersion ? this.indexOf(toVersion) : -1,
			isInitial,
		};
	}

	/**
	 * Will try to upgrade to specified target version.
	 */
	async up(
		target: "latest" | "major" | "minor" | "patch" | string = "latest"
	): Promise<number | string> {
		const activeVersion = await this.getActiveVersion();
		const { fromIndex, toIndex, fromVersion, toVersion, isInitial } =
			(await this.__upMeta(target, activeVersion)) ?? {};

		if (
			fromIndex === undefined ||
			toIndex === undefined ||
			fromIndex === -1 ||
			toIndex === -1
		) {
			throw new Error(
				this.#log(`Unable to find matching up version for "${target}"`)
			);
		}

		let successCounter = 0;

		job: {
			// are we already up to date?
			if (fromIndex >= toIndex && !isInitial) {
				this.#log(
					`Ignoring as already at or above the target ("${fromVersion}" >= "${toVersion}")`
				);
				break job;
			}

			this.#log(`--> Plan: "${activeVersion}" -> "${toVersion}"`);

			// "from" is exclusive (unless not initial), "to" is inclusive
			for (let i = fromIndex; i <= toIndex; i++) {
				// special case skip first step if not initial
				if (!isInitial && i === fromIndex) continue;

				//
				const version = this.#versions.at(i);

				// this is unexpected here... must have been some error in the upMeta
				if (!version) {
					throw new Error(
						`Version not found?!? (${fromVersion}, ${fromIndex})`
					);
				}

				// prettier-ignore
				this.#log(`--> Upgrading from "${await this.getActiveVersion()}" to "${version}" ...`);

				try {
					// actual upgrade
					await version.up(this.context);
				} catch (e) {
					throw new Error(
						`The upgrade to version "${version}" failed (Details: ${e})`
					);
				}

				try {
					await this.setActiveVersion(version);
					successCounter++;
					this.#log(`OK "${version}"`);
				} catch (e) {
					throw new Error(
						`The upgrade operation succeeded, but was unable to save the upgraded ` +
							`version "${version}". System may be unstable. You should manually ` +
							`fix the version before continuing. (Details: ${e})`
					);
				}
			}
		}

		this.#log(`--> ✔ Done in ${successCounter} steps`);

		return Promise.resolve(successCounter);
	}

	/**
	 * Helper to search for the matching up version and related info.
	 * Down operation is NOT "greedy" and always tends to to go just one step down.
	 */
	async __downMeta(
		target: "initial" | "major" | "minor" | "patch" | string = "major",
		fromVersionLabel?: string
	): Promise<
		| {
				toVersion: string | undefined;
				toIndex: number;
				fromVersion: string;
				fromIndex: number;
		  }
		| undefined
	> {
		// no versions, nothing to do...
		if (!this.#versions.size) return undefined;

		fromVersionLabel ??= await this.getActiveVersion();
		if (!fromVersionLabel) {
			throw new Error("Cannot downgrade from undefined version");
		}

		const from = await this.findVersion(fromVersionLabel, true)!;

		// this is unexpected... getActiveVersion() must have returned unknown version
		if (!from) {
			throw new Error(`Version not found ("${fromVersionLabel}")?!?`);
		}

		let toVersion: string | undefined = target;

		//
		if (target === "initial") {
			toVersion = this.#versions.at(0)!.version;
		}
		//
		else if (target === "major") {
			// this will find the previous closest major, event if there are gaps
			toVersion =
				this.__versions.items
					.filter((v) => v.major < from.major)
					.map((v) => v.version)
					.at(-1) ?? from.version;
		}
		//
		else if (target === "minor") {
			toVersion =
				this.__versions.items
					.filter((v) => v.major === from.major && v.minor < from.minor)
					.map((v) => v.version)
					.at(-1) ?? from.version;
		}
		//
		else if (target === "patch") {
			toVersion =
				this.__versions.items
					.filter(
						(v) =>
							v.major === from.major &&
							v.minor === from.minor &&
							v.patch < from.patch
					)
					.map((v) => v.version)
					.at(-1) ?? from.version;
		}
		//
		else {
			toVersion = this.findVersion(target)?.version;
		}

		return {
			fromVersion: from.version,
			fromIndex: this.indexOf(from.version),
			toVersion,
			toIndex: toVersion ? this.indexOf(toVersion) : -1,
		};
	}

	/**
	 * Will try to downgrade to specified target version.
	 */
	async down(
		target: "initial" | "major" | "minor" | "patch" | string = "major"
	): Promise<number> {
		const activeVersion = await this.getActiveVersion();
		if (!activeVersion) {
			throw new Error("Cannot downgrade from undefined version");
		}

		const { fromIndex, toIndex, fromVersion, toVersion } =
			(await this.__downMeta(target, activeVersion)) ?? {};

		if (
			fromIndex === undefined ||
			toIndex === undefined ||
			fromIndex === -1 ||
			toIndex === -1
		) {
			throw new Error(
				this.#log(`Unable to find matching down version for "${target}"`)
			);
		}

		let successCounter = 0;

		job: {
			// returning 0 here, which is still a valid no-error result
			if (fromIndex <= toIndex) {
				this.#log(
					`Ignoring as already at or below the target ("${fromVersion}" <= "${toVersion}")`
				);
				break job;
			}

			this.#log(`--> Plan: "${activeVersion}" -> "${toVersion}"`);

			// "to" is exclusive
			for (let i = fromIndex; i > toIndex; i--) {
				// this is a version instance on which we'll call the downgrade fn
				// (note, that is not the "target" to which we're downgrading)
				const version = this.#versions.at(i);

				// Here we are downgrading... so our target is-1
				const target = this.#versions.at(i - 1);

				// this is unexpected here... must have been some error in the upMeta
				// prettier-ignore
				if (!version) throw new Error(`Version not found?!? (${fromVersion}, ${fromIndex})`);

				// prettier-ignore
				this.#log(`--> Downgrading from "${await this.getActiveVersion()}" to "${target?.version}" ...`);

				try {
					// actual downgrade
					await version.down(this.context);
				} catch (e) {
					throw new Error(
						`The downgrade to version "${version}" failed (Details: ${e})`
					);
				}

				try {
					await this.setActiveVersion(target?.version);
					successCounter++;
					// here, we just downgraded
					this.#log(`OK "${target?.version}"`);
				} catch (e) {
					throw new Error(
						`The downgrade operation succeeded, but was unable to save the downgraded ` +
							`version "${target?.version}". System may be unstable. You should manually ` +
							`fix the version before continuing. (Details: ${e})`
					);
				}
			}
		}

		this.#log(`--> ✔ Done in ${successCounter} steps`);

		return Promise.resolve(successCounter);
	}

	/** A special case downgrade, which will downgrade from the initial version
	 * to a complete blank slate */
	async uninstall(): Promise<number> {
		this.#log(`--> Uninstalling ...`);
		if ((await this.getActiveVersion()) === undefined) {
			this.#log("Ignoring, as no active version was found");
			return 0;
		}

		let successCounter = await this.down("initial");

		try {
			this.#log(`--> Final down step`);
			await this.#versions.at(0)!.down(this.context);
			successCounter++;
		} catch (e) {
			throw new Error(`The uninstall failed (Details: ${e})`);
		}

		try {
			await this.setActiveVersion(undefined);
			// this.#log(`OK, uninstalled`);
		} catch (e) {
			throw new Error(
				`The uninstall operation itself succeeded, but was unable to remove the ` +
					`version mark. System may be unstable. You should manually ` +
					`remove the version before continuing. (Details: ${e})`
			);
		}

		this.#log(`--> ✔ Uninstalled in ${successCounter} steps`);

		return Promise.resolve(successCounter);
	}
}
