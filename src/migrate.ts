/**
 * @module
 * Core migration classes for managing versioned changes.
 *
 * Provides the {@linkcode Migrate} class for orchestrating migrations and
 * the {@linkcode Version} class for representing individual versions.
 */
import { ItemCollection } from "@marianmeres/item-collection";
import { parseSemver } from "./mod.ts";
import { compareSemver, normalizeSemver } from "./semver.ts";

/** The constructor options for the Migrate class. */
export interface MigrateOptions {
	/** Active version getter (e.g., reader from database). If not provided, will read from memory. */
	getActiveVersion: (
		context: Record<string, unknown>,
	) => Promise<string | undefined>;
	/**
	 * Active version setter (e.g., writer to database). If not provided, will keep in memory.
	 * The returned value (if any) is ignored by the framework.
	 */
	setActiveVersion: (
		version: string | undefined,
		context: Record<string, unknown>,
	) => Promise<unknown>;
	/** Optional logger for debugging purposes. */
	logger?: (...args: unknown[]) => void;
}

/**
 * The migration function type used for up and down operations.
 * @param context - Optional context object passed to the migration function.
 * @returns void or a Promise that resolves to void.
 */
export type MigrateFn = (context?: Record<string, unknown>) => void | Promise<void>;

/** Single version abstraction. */
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

	/**
	 * Stored `down` worker. `null` means this version is one-way (irreversible).
	 */
	#down: MigrateFn | null;

	#logger?: (...args: unknown[]) => void;

	/**
	 * Creates a new Version instance.
	 * @param version - The version string (will be normalized to semver format).
	 * @param up - The upgrade function to execute when migrating up to this version.
	 * @param down - The downgrade function to execute when migrating down from this version.
	 * Pass `null` or `undefined` to mark this version as irreversible (one-way).
	 * @param comment - Optional comment or description for this version.
	 * @param logger - Optional logger function.
	 */
	constructor(
		version: string,
		up: MigrateFn,
		down?: MigrateFn | null,
		public readonly comment: string | undefined = undefined,
		logger?: (...args: unknown[]) => void,
	) {
		if (!version || typeof up !== "function") {
			throw new TypeError("Invalid version parameters");
		}
		if (down !== undefined && down !== null && typeof down !== "function") {
			throw new TypeError("Invalid version parameters");
		}

		// Always keep normalized
		this.version = normalizeSemver(version);

		// Parse semver segments and store them individually (so we can query them easily)
		const { major, minor, patch, prerelease, build } = parseSemver(
			this.version,
		);
		this.major = major;
		this.minor = minor;
		this.patch = patch;
		this.prerelease = prerelease;
		this.build = build;

		// Actual migrate workers
		this.#up = up;
		this.#down = down ?? null;
		this.#logger = logger;
	}

	/** Whether this version has a downgrade function (is reversible). */
	get isReversible(): boolean {
		return this.#down !== null;
	}

	/**
	 * Executes the upgrade migration function for this version.
	 * @param context - The context object to pass to the migration function.
	 * @returns The result of the upgrade function.
	 */
	up(context: Parameters<MigrateFn>[0]): ReturnType<MigrateFn> {
		this.#logger?.(`[${this.version}] up worker ...`);
		return this.#up(context);
	}

	/**
	 * Executes the downgrade migration function for this version.
	 * @param context - The context object to pass to the migration function.
	 * @returns The result of the downgrade function.
	 * @throws {Error} If this version was registered without a downgrade function.
	 */
	down(context: Parameters<MigrateFn>[0]): ReturnType<MigrateFn> {
		if (this.#down === null) {
			throw new Error(
				`Version "${this.version}" is irreversible (no down worker registered)`,
			);
		}
		this.#logger?.(`[${this.version}] down worker ...`);
		return this.#down(context);
	}

	/**
	 * Returns the string representation of this version.
	 * @returns The normalized version string.
	 */
	toString(): string {
		return this.version;
	}
}

/** Plan step returned by {@link Migrate.plan}. */
export interface PlanStep {
	/** The version on which the worker is invoked. */
	version: string;
	/** The version that will become active after this step succeeds. */
	activeAfter: string | undefined;
}

/** Plan returned by {@link Migrate.plan}. */
export interface Plan {
	direction: "up" | "down";
	fromVersion: string | undefined;
	toVersion: string | undefined;
	steps: PlanStep[];
}

/** Status snapshot returned by {@link Migrate.status}. */
export interface Status {
	active: string | undefined;
	latest: string | undefined;
	isAtLatest: boolean;
	pending: string[];
}

/**
 * The main migration manager that handles version tracking and migration execution.
 */
export class Migrate {
	/** Internal sort function (wrapper around compareSemver). */
	#compareFn = (a: Version, b: Version) => compareSemver(a.version, b.version);

	/** Internal collection of Version instances. */
	#versions = new ItemCollection<Version>([], {
		idPropName: "version",
		sortFn: this.#compareFn,
		searchable: {
			getContent: (v) => {
				// Remove dots from comment since we're using it in non-word whitelist
				// (to avoid polluting the search index)
				return `${v.version} ${(v.comment || "").replaceAll(".", " ")}`;
			},
			nonWordCharWhitelist: ".",
			index: "trie",
		},
		unique: true,
	});

	/** The migration options. */
	#options: Partial<MigrateOptions> = {};

	/**
	 * Tail of the serialization queue. All up/down/uninstall operations chain
	 * off this promise so they run one at a time per instance.
	 */
	#queue: Promise<unknown> = Promise.resolve();

	/**
	 * Creates a new Migrate instance.
	 * @param options - Configuration options for version storage and logging.
	 * @param context - Arbitrary context object passed to each migration function.
	 */
	constructor(
		options: Partial<MigrateOptions> = {},
		/** Arbitrary context object passed to each up/down migration. */
		public context: Record<string, any> = {},
	) {
		this.#options = { ...this.#options, ...options };
	}

	/** Internal debug logger. */
	#log(...args: any[]) {
		args = [`[${new Date().toISOString()}] [migrate]`, ...args];
		this.#options?.logger?.(...args);
		return args[1];
	}

	/**
	 * Serializes async operations so that concurrent calls to {@link up},
	 * {@link down}, or {@link uninstall} run one at a time per instance.
	 */
	#serialize<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.#queue.then(fn, fn);
		this.#queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/**
	 * Syncs the internal collection's active item with an externally-sourced
	 * version label. No-op when internal state already matches.
	 */
	#syncActive(version: string | undefined): void {
		const current = this.#versions.active?.version;
		if (version === current) return;

		if (version === undefined) {
			this.#versions.unsetActive();
			return;
		}

		const match = this.#versions.findById(version);
		if (match) {
			this.#versions.setActive(match);
		} else {
			// Unknown version - leave internal state unset rather than invent one.
			this.#versions.unsetActive();
		}
	}

	/**
	 * Gets the internal collection instance for debugging or advanced use cases.
	 * @returns The internal ItemCollection instance.
	 */
	get __versions(): ItemCollection<Version> {
		return this.#versions;
	}

	/**
	 * Gets all Version instances as an array.
	 * @returns Array of all registered Version instances.
	 */
	get versions(): Version[] {
		return this.#versions.items;
	}

	/**
	 * Gets all available version strings.
	 * @returns Array of all registered version strings in semver format.
	 */
	get available(): string[] {
		return this.#versions.items.map((v) => v.version);
	}

	/**
	 * Gets the internal sort function for reuse in external code.
	 * @returns The comparison function used for sorting versions.
	 */
	get compareFn(): (a: Version, b: Version) => number {
		return this.#compareFn;
	}

	/**
	 * Adds a new version to the migration registry.
	 * @param version - The version string (will be normalized to semver format).
	 * @param up - The upgrade function to execute when migrating up to this version.
	 * @param down - The downgrade function to execute when migrating down from
	 * this version. Pass `null` or `undefined` to mark the version as
	 * irreversible (one-way); in that case {@link down} and {@link uninstall}
	 * will fail when they reach this version.
	 * @param comment - Optional comment or description for this version.
	 * @returns The created Version instance.
	 * @throws {Error} If the version already exists.
	 */
	addVersion(
		version: string,
		up: MigrateFn,
		down?: MigrateFn | null,
		comment: string | undefined = undefined,
	): Version {
		const _version = new Version(
			version,
			up,
			down,
			comment,
			(...args) => this.#log(...args),
		);

		// The internal collection does not assert, but we want to be strict here
		if (this.__versions.findById(_version.version)) {
			throw new Error(`Version already exists ("${version}")`);
		}

		this.#versions.add(_version);

		return _version;
	}

	/**
	 * Gets the currently active version.
	 *
	 * When an external `getActiveVersion` option is configured, it is the
	 * source of truth and the internal collection's active item is synced to
	 * its result on every call.
	 *
	 * @returns The active version string, or undefined if not set.
	 */
	async getActiveVersion(): Promise<string | undefined> {
		// Maybe read from external system
		if (typeof this.#options.getActiveVersion === "function") {
			let version = await this.#options.getActiveVersion(this.context);
			if (version) version = normalizeSemver(version);
			const normalized = version || undefined;
			this.#syncActive(normalized);
			return normalized;
		}
		return this.#versions.active?.version;
	}

	/**
	 * Sets the currently active version.
	 * @param version - The version to set as active. Can be a version string, Version instance, "latest", "initial", or undefined.
	 * @returns The newly set active version string, or undefined.
	 * @throws {Error} If the specified version does not exist.
	 */
	async setActiveVersion(
		version: "latest" | "initial" | undefined | string | Version,
	): Promise<string | undefined> {
		// Special case: undefined (marking the system as "uninstalled")
		if (version === undefined) {
			this.#versions.unsetActive();
		} // We have a provided version
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

			// Provided version must exist
			const active = _version ? this.#versions.findById(_version) : undefined;
			if (!_version || !active) {
				throw new Error(`Version not found ("${version}")`);
			}

			// Sync to instance
			this.#versions.setActive(active);
		}

		const active = this.#versions.active?.version;

		// Maybe save to external system as well
		await this.#options.setActiveVersion?.(active, this.context);
		this.#log("setActiveVersion:", active);

		return active;
	}

	/**
	 * Forces the active version marker without validating that the version
	 * exists in the registered set. Useful for recovering from a partial
	 * failure where a migration succeeded but the version marker was not
	 * persisted (or was persisted to an unexpected value).
	 *
	 * The internal active item is cleared if the provided version is unknown;
	 * the external setter (if configured) is still called with the supplied
	 * value verbatim.
	 *
	 * @param version - Semver string, or undefined to clear the marker.
	 * @returns The resolved (normalized) version written, or undefined.
	 */
	async forceSetActiveVersion(
		version: string | undefined,
	): Promise<string | undefined> {
		const normalized = version === undefined ? undefined : normalizeSemver(version);
		this.#syncActive(normalized);
		await this.#options.setActiveVersion?.(normalized, this.context);
		this.#log("forceSetActiveVersion:", normalized);
		return normalized;
	}

	/**
	 * Returns the index of a version in the internal store.
	 * @param version - The version string to find.
	 * @returns The index of the version, or -1 if not found.
	 */
	indexOf(version: string): number {
		version = normalizeSemver(version);
		return this.#versions.findIndexBy("version", version);
	}

	/**
	 * Finds a version instance by version string.
	 * @param version - The version string to find.
	 * @param assert - If true, throws an error when version is not found.
	 * @returns The Version instance, or undefined if not found.
	 * @throws {Error} If assert is true and version is not found.
	 */
	findVersion(version: string, assert = false): Version | undefined {
		const index = this.indexOf(version);
		const out = index > -1 ? this.#versions.at(index) : undefined;
		if (assert && !out) {
			throw new Error(`Version not found ("${version}")`);
		}
		return out;
	}

	/**
	 * Internal helper to calculate upgrade metadata.
	 * The upgrade operation is "greedy" and attempts to go forward as much as possible within the specified constraints.
	 * @param target - The target version or semver increment ("latest", "major", "minor", "patch", or specific version).
	 * @param fromVersionLabel - The starting version (defaults to current active version).
	 * @returns Metadata about the upgrade path, or undefined if no versions exist.
	 */
	async __upMeta(
		target: "latest" | "major" | "minor" | "patch" | string = "latest",
		fromVersionLabel?: string | undefined,
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
		// No versions, nothing to do
		if (!this.#versions.size) return undefined;

		fromVersionLabel ??= await this.getActiveVersion();
		const isInitial = fromVersionLabel === undefined;
		const from = fromVersionLabel
			? await this.findVersion(fromVersionLabel, true)!
			: this.#versions.at(0)!;

		// This is unexpected - getActiveVersion() must have returned an unknown version
		if (!from) {
			throw new Error(`Version not found ("${fromVersionLabel}")?!?`);
		}

		//
		let toVersion: string | undefined;

		//
		if (target === "latest") {
			toVersion = this.#versions.at(-1)!.version;
		} //
		else if (target === "major") {
			// Find the next major (first version strictly greater with a larger
			// major segment), then the highest version within that major.
			const nextMajor = this.#versions.items
				.filter(
					(v) =>
						v.major > from.major &&
						compareSemver(v.version, from.version) > 0,
				)
				.at(0);

			if (nextMajor) {
				toVersion = this.#versions.items
					.filter((v) => v.major === nextMajor.major)
					.map((v) => v.version)
					.at(-1);
			}
			toVersion ??= from.version;
		} //
		else if (target === "minor") {
			toVersion = this.#versions.items
				.filter(
					(v) =>
						v.major === from.major &&
						compareSemver(v.version, from.version) > 0,
				)
				.map((v) => v.version)
				.at(-1) ?? from.version;
		} //
		else if (target === "patch") {
			toVersion = this.#versions.items
				.filter(
					(v) =>
						v.major === from.major &&
						v.minor === from.minor &&
						compareSemver(v.version, from.version) > 0,
				)
				.map((v) => v.version)
				.at(-1) ?? from.version;
		} //
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
	 * Executes migration upgrades to the specified target version.
	 * @param target - The target version or semver increment ("latest", "major", "minor", "patch", or specific version).
	 * @returns The number of migration steps executed.
	 * @throws {Error} If the target version is not found or if a migration fails.
	 */
	up(
		target: "latest" | "major" | "minor" | "patch" | string = "latest",
	): Promise<number> {
		return this.#serialize(() => this.#upUnlocked(target));
	}

	async #upUnlocked(
		target: "latest" | "major" | "minor" | "patch" | string,
	): Promise<number> {
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
				this.#log(`Unable to find matching up version for "${target}"`),
			);
		}

		let successCounter = 0;

		job: {
			// Are we already up to date?
			if (fromIndex >= toIndex && !isInitial) {
				this.#log(
					`Ignoring as already at or above the target ("${fromVersion}" >= "${toVersion}")`,
				);
				break job;
			}

			this.#log(`--> Plan: "${activeVersion}" -> "${toVersion}"`);

			// "from" is exclusive (unless initial), "to" is inclusive
			for (let i = fromIndex; i <= toIndex; i++) {
				// Special case: skip first step if not initial
				if (!isInitial && i === fromIndex) continue;

				//
				const version = this.#versions.at(i);

				// This is unexpected - there must have been an error in upMeta
				if (!version) {
					throw new Error(
						`Version not found?!? (${fromVersion}, ${fromIndex})`,
					);
				}

				this.#log(
					`--> Upgrading from "${this.#versions.active?.version}" to "${version}" ...`,
				);

				try {
					// Execute the upgrade
					await version.up(this.context);
				} catch (e) {
					throw new Error(
						`The upgrade to version "${version}" failed (Details: ${e})`,
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
							`fix the version before continuing. (Details: ${e})`,
					);
				}
			}
		}

		this.#log(`--> ✔ Done in ${successCounter} steps`);

		return successCounter;
	}

	/**
	 * Internal helper to calculate downgrade metadata.
	 * The downgrade operation is NOT "greedy" and tends to go just one step down.
	 * @param target - The target version or semver decrement ("initial", "major", "minor", "patch", or specific version).
	 * @param fromVersionLabel - The starting version (defaults to current active version).
	 * @returns Metadata about the downgrade path, or undefined if no versions exist.
	 */
	async __downMeta(
		target: "initial" | "major" | "minor" | "patch" | string = "major",
		fromVersionLabel?: string,
	): Promise<
		| {
			toVersion: string | undefined;
			toIndex: number;
			fromVersion: string;
			fromIndex: number;
		}
		| undefined
	> {
		// No versions, nothing to do
		if (!this.#versions.size) return undefined;

		fromVersionLabel ??= await this.getActiveVersion();
		if (!fromVersionLabel) {
			throw new Error("Cannot downgrade from undefined version");
		}

		const from = this.findVersion(fromVersionLabel, true)!;

		let toVersion: string | undefined = target;

		//
		if (target === "initial") {
			toVersion = this.#versions.at(0)!.version;
		} //
		else if (target === "major") {
			// This will find the previous closest major, even if there are gaps
			toVersion = this.#versions.items
				.filter(
					(v) =>
						v.major < from.major &&
						compareSemver(v.version, from.version) < 0,
				)
				.map((v) => v.version)
				.at(-1) ?? from.version;
		} //
		else if (target === "minor") {
			toVersion = this.#versions.items
				.filter(
					(v) =>
						v.major === from.major &&
						v.minor < from.minor &&
						compareSemver(v.version, from.version) < 0,
				)
				.map((v) => v.version)
				.at(-1) ?? from.version;
		} //
		else if (target === "patch") {
			toVersion = this.#versions.items
				.filter(
					(v) =>
						v.major === from.major &&
						v.minor === from.minor &&
						compareSemver(v.version, from.version) < 0,
				)
				.map((v) => v.version)
				.at(-1) ?? from.version;
		} //
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
	 * Executes migration downgrades to the specified target version.
	 * @param target - The target version or semver decrement ("initial", "major", "minor", "patch", or specific version).
	 * @returns The number of migration steps executed.
	 * @throws {Error} If there is no active version, target is not found, or if a migration fails.
	 */
	down(
		target: "initial" | "major" | "minor" | "patch" | string = "major",
	): Promise<number> {
		return this.#serialize(() => this.#downUnlocked(target));
	}

	async #downUnlocked(
		target: "initial" | "major" | "minor" | "patch" | string,
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
				this.#log(`Unable to find matching down version for "${target}"`),
			);
		}

		let successCounter = 0;

		job: {
			// Returning 0 here, which is still a valid no-error result
			if (fromIndex <= toIndex) {
				this.#log(
					`Ignoring as already at or below the target ("${fromVersion}" <= "${toVersion}")`,
				);
				break job;
			}

			this.#log(`--> Plan: "${activeVersion}" -> "${toVersion}"`);

			// "to" is exclusive
			for (let i = fromIndex; i > toIndex; i--) {
				// This is the version instance on which we'll call the downgrade function
				// (note that this is not the "target" to which we're downgrading)
				const version = this.#versions.at(i);

				// When downgrading, our target is i-1
				const nextActive = this.#versions.at(i - 1);

				// This is unexpected - there must have been an error in downMeta
				if (!version) {
					throw new Error(
						`Version not found?!? (${fromVersion}, ${fromIndex})`,
					);
				}

				this.#log(
					`--> Downgrading from "${this.#versions.active?.version}" to "${nextActive?.version}" ...`,
				);

				try {
					// Execute the downgrade
					await version.down(this.context);
				} catch (e) {
					throw new Error(
						`The downgrade to version "${version}" failed (Details: ${e})`,
					);
				}

				try {
					await this.setActiveVersion(nextActive?.version);
					successCounter++;
					// We just downgraded
					this.#log(`OK "${nextActive?.version}"`);
				} catch (e) {
					throw new Error(
						`The downgrade operation succeeded, but was unable to save the downgraded ` +
							`version "${nextActive?.version}". System may be unstable. You should manually ` +
							`fix the version before continuing. (Details: ${e})`,
					);
				}
			}
		}

		this.#log(`--> ✔ Done in ${successCounter} steps`);

		return successCounter;
	}

	/**
	 * Performs a complete uninstall by downgrading from the initial version to a blank slate.
	 * This is a special case that removes even the initial version.
	 * @returns The number of migration steps executed.
	 * @throws {Error} If the uninstall operation fails (including when the initial version is irreversible).
	 */
	uninstall(): Promise<number> {
		return this.#serialize(() => this.#uninstallUnlocked());
	}

	async #uninstallUnlocked(): Promise<number> {
		this.#log(`--> Uninstalling ...`);
		if ((await this.getActiveVersion()) === undefined) {
			this.#log("Ignoring, as no active version was found");
			return 0;
		}

		let successCounter = await this.#downUnlocked("initial");

		try {
			this.#log(`--> Final down step`);
			await this.#versions.at(0)!.down(this.context);
			successCounter++;
		} catch (e) {
			throw new Error(`The uninstall failed (Details: ${e})`);
		}

		try {
			await this.setActiveVersion(undefined);
		} catch (e) {
			throw new Error(
				`The uninstall operation itself succeeded, but was unable to remove the ` +
					`version mark. System may be unstable. You should manually ` +
					`remove the version before continuing. (Details: ${e})`,
			);
		}

		this.#log(`--> ✔ Uninstalled in ${successCounter} steps`);

		return successCounter;
	}

	/**
	 * Produces the ordered list of steps that {@link up} or {@link down} would
	 * execute for the given target without actually running any migration
	 * functions or mutating any state. Useful for dry-runs, UIs and tests.
	 *
	 * @param direction - "up" or "down".
	 * @param target - Semver keyword ("latest"/"major"/"minor"/"patch" for up;
	 * "initial"/"major"/"minor"/"patch" for down) or a specific version.
	 * @returns A {@link Plan} describing the computed path.
	 * @throws {Error} If the target cannot be resolved, or for `down` when
	 * there is no active version.
	 */
	async plan(
		direction: "up" | "down",
		target?: string,
	): Promise<Plan> {
		if (direction === "up") {
			const activeVersion = await this.getActiveVersion();
			const meta = await this.__upMeta(target ?? "latest", activeVersion);
			const fromIndex = meta?.fromIndex ?? -1;
			const toIndex = meta?.toIndex ?? -1;
			if (fromIndex === -1 || toIndex === -1) {
				throw new Error(`Unable to find matching up version for "${target}"`);
			}
			const steps: PlanStep[] = [];
			if (meta && (meta.isInitial || fromIndex < toIndex)) {
				for (let i = fromIndex; i <= toIndex; i++) {
					if (!meta.isInitial && i === fromIndex) continue;
					const v = this.#versions.at(i)!;
					steps.push({ version: v.version, activeAfter: v.version });
				}
			}
			return {
				direction: "up",
				fromVersion: activeVersion,
				toVersion: meta?.toVersion,
				steps,
			};
		}

		const activeVersion = await this.getActiveVersion();
		if (!activeVersion) {
			throw new Error("Cannot downgrade from undefined version");
		}
		const meta = await this.__downMeta(target ?? "major", activeVersion);
		const fromIndex = meta?.fromIndex ?? -1;
		const toIndex = meta?.toIndex ?? -1;
		if (fromIndex === -1 || toIndex === -1) {
			throw new Error(`Unable to find matching down version for "${target}"`);
		}
		const steps: PlanStep[] = [];
		if (meta && fromIndex > toIndex) {
			for (let i = fromIndex; i > toIndex; i--) {
				const v = this.#versions.at(i)!;
				const next = this.#versions.at(i - 1);
				steps.push({ version: v.version, activeAfter: next?.version });
			}
		}
		return {
			direction: "down",
			fromVersion: activeVersion,
			toVersion: meta?.toVersion,
			steps,
		};
	}

	/**
	 * Produces a status snapshot.
	 * @returns Current active version, latest known version, whether we are at
	 * the latest, and the list of pending version strings.
	 */
	async status(): Promise<Status> {
		const active = await this.getActiveVersion();
		const all = this.available;
		const latest = all.at(-1);
		let pending: string[];
		if (active === undefined) {
			pending = all.slice();
		} else {
			const idx = this.indexOf(active);
			pending = idx === -1 ? all.slice() : all.slice(idx + 1);
		}
		return {
			active,
			latest,
			isAtLatest: active !== undefined && active === latest,
			pending,
		};
	}
}
