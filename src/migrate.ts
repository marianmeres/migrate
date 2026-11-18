/**
 * @module
 * Core migration classes for managing versioned changes.
 *
 * Provides the {@linkcode Migrate} class for orchestrating migrations and
 * the {@linkcode Version} class for representing individual versions.
 */
import { ItemCollection } from "@marianmeres/item-collection";
import { compareSemver, normalizeSemver, parseSemver } from "@marianmeres/semver";

/**
 * The migration worker type used for up and down operations.
 *
 * Receives the context given to the {@linkcode Migrate} constructor. A returned
 * promise is awaited; any other returned value is ignored.
 */
export type MigrateFn<TContext = any> = (context: TContext) => unknown;

/** Plan step returned by {@link Migrate.plan}. */
export interface PlanStep {
	/** The version on which the worker is invoked. */
	version: string;
	/** The version that will become active after this step succeeds. */
	activeAfter: string | undefined;
	/**
	 * Whether the version has a `down` worker. A down plan holding a step that is
	 * not reversible cannot be executed: {@link Migrate.down} and
	 * {@link Migrate.uninstall} refuse it before running anything.
	 */
	reversible: boolean;
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
	/** Registered versions strictly above the active one, in semver order. */
	pending: string[];
}

/** The step a `wrapStep` hook is wrapping. */
export interface StepInfo extends PlanStep {
	/** Which worker of `version` the step runs. */
	direction: "up" | "down";
}

/** The operation a `wrapRun` hook is wrapping. */
export interface RunInfo {
	operation: "up" | "down" | "uninstall";
	/** The target as given to `up()` / `down()` (defaults applied); undefined for uninstall. */
	target: string | undefined;
}

/** The constructor options for the Migrate class. All are optional. */
export interface MigrateOptions<TContext = any> {
	/**
	 * Active version reader (e.g., from a database). Must come together with
	 * `setActiveVersion`; with neither, the active version is kept in memory.
	 * `undefined`, `null` and `""` all mean "nothing is installed".
	 */
	getActiveVersion?: (
		context: TContext,
	) => string | null | undefined | Promise<string | null | undefined>;
	/**
	 * Active version writer (e.g., to a database). Must come together with
	 * `getActiveVersion`. A returned promise is awaited; the value is ignored.
	 */
	setActiveVersion?: (version: string | undefined, context: TContext) => unknown;
	/**
	 * Wraps every single step: `run()` executes the version's worker and then writes
	 * the active version. Call and await `run()` exactly once. Typically a
	 * transaction, which makes the worker and the marker write atomic:
	 * begin, `await run()`, commit; roll back and rethrow when it throws.
	 *
	 * The step counts as failed when the hook throws, also after `run()` returned.
	 */
	wrapStep?: (run: () => Promise<void>, step: StepInfo, context: TContext) => unknown;
	/**
	 * Wraps a whole `up()` / `down()` / `uninstall()` call, including the read of the
	 * active version it starts from. Call and await `run()` exactly once. Typically a
	 * lock, so that two processes never migrate the same system at once.
	 */
	wrapRun?: (run: () => Promise<void>, info: RunInfo, context: TContext) => unknown;
	/** Optional logger for debugging purposes. */
	logger?: (...args: unknown[]) => void;
}

/** Single version abstraction. */
export class Version<TContext = any> {
	public readonly comment: string | undefined;
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

	#up: MigrateFn<TContext>;

	/**
	 * Stored `down` worker. `null` means this version is one-way (irreversible).
	 */
	#down: MigrateFn<TContext> | null;

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
		up: MigrateFn<TContext>,
		down?: MigrateFn<TContext> | null,
		comment: string | undefined = undefined,
		logger?: (...args: unknown[]) => void,
	) {
		this.comment = comment;
		if (!version || typeof up !== "function") {
			throw new TypeError("Invalid version parameters");
		}
		if (down !== undefined && down !== null && typeof down !== "function") {
			throw new TypeError("Invalid version parameters");
		}

		// Always keep normalized
		this.version = normalizeSemver(version);

		// Parse semver segments and store them individually (so we can query them easily)
		const { major, minor, patch, prerelease, build } = parseSemver(this.version);
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
	up(context: TContext): unknown {
		this.#logger?.(`[${this.version}] up worker ...`);
		return this.#up(context);
	}

	/**
	 * Executes the downgrade migration function for this version.
	 * @param context - The context object to pass to the migration function.
	 * @returns The result of the downgrade function.
	 * @throws {Error} If this version was registered without a downgrade function.
	 */
	down(context: TContext): unknown {
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

/**
 * The main migration manager that handles version tracking and migration execution.
 *
 * `TContext` is the type of the context object every worker and option callback
 * receives. It is inferred from the constructor's second argument, or given
 * explicitly: `new Migrate<{ db: Db }>(options, { db })`. A bare `Migrate` is
 * `Migrate<any>`, the type that accepts an instance of any context.
 */
export class Migrate<TContext extends Record<string, any> = any> {
	/** Arbitrary context object passed to each up/down migration. */
	public context: TContext;
	/** Internal sort function (wrapper around compareSemver). */
	#compareFn = (a: Version<TContext>, b: Version<TContext>): number =>
		compareSemver(a.version, b.version);

	/** Internal collection of Version instances. */
	#versions = new ItemCollection<Version<TContext>>([], {
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
	#options: MigrateOptions<TContext> = {};

	/**
	 * Tail of the serialization queue. All up/down/uninstall operations chain
	 * off this promise so they run one at a time per instance.
	 */
	#queue: Promise<unknown> = Promise.resolve();

	/**
	 * Creates a new Migrate instance.
	 * @param options - Configuration options for version storage, hooks and logging.
	 * @param context - Arbitrary context object passed to each migration function.
	 * @throws {TypeError} If only one of `getActiveVersion` / `setActiveVersion` is given.
	 */
	constructor(
		options: MigrateOptions<TContext> = {},
		/** Arbitrary context object passed to each up/down migration. */
		context: TContext = {} as TContext,
	) {
		this.context = context;

		// A reader without a writer would re-run every version on each call, and a
		// writer without a reader is never consulted: neither is a working setup.
		const hasReader = typeof options.getActiveVersion === "function";
		const hasWriter = typeof options.setActiveVersion === "function";
		if (hasReader !== hasWriter) {
			throw new TypeError(
				`The "getActiveVersion" and "setActiveVersion" options must be provided ` +
					`together (or not at all)`,
			);
		}

		this.#options = { ...options };
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
	 * Runs `fn` through an optional user hook, which is handed a `run` callback.
	 *
	 * What happened to `fn` is tracked here and never taken from the hook's word: a
	 * hook that returns without having awaited `run()`, or that swallows its
	 * failure, does not turn into a success.
	 */
	async #wrap<T>(
		name: "wrapRun" | "wrapStep",
		subject: string,
		hook: ((run: () => Promise<void>) => unknown) | undefined,
		fn: () => Promise<T>,
	): Promise<T> {
		if (!hook) return fn();

		const call: {
			state: "pending" | "running" | "done" | "failed";
			result?: T;
			error?: unknown;
		} = { state: "pending" };

		const run = async () => {
			if (call.state !== "pending") {
				throw new Error(`The "${name}" hook must call run() exactly once`);
			}
			call.state = "running";
			try {
				call.result = await fn();
				call.state = "done";
			} catch (e) {
				call.state = "failed";
				call.error = e;
				throw e;
			}
		};

		try {
			await hook(run);
		} catch (e) {
			// The failure of the work itself is the one worth reporting, whatever
			// the hook threw while handling it
			if (call.state === "failed") throw call.error;
			throw new Error(
				call.state === "done"
					? `The "${name}" hook failed after ${subject} completed ` +
							`(Details: ${e})`
					: `The "${name}" hook failed for ${subject} (Details: ${e})`,
				{ cause: e },
			);
		}

		// The hook swallowed the failure
		if (call.state === "failed") throw call.error;

		if (call.state !== "done") {
			throw new Error(
				`The "${name}" hook returned without calling and awaiting run() ` +
					`for ${subject}`,
			);
		}

		return call.result as T;
	}

	/**
	 * Gets the internal collection instance for debugging or advanced use cases.
	 * @returns The internal ItemCollection instance.
	 */
	get __versions(): ItemCollection<Version<TContext>> {
		return this.#versions;
	}

	/**
	 * Gets all Version instances as an array.
	 * @returns Array of all registered Version instances.
	 */
	get versions(): Version<TContext>[] {
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
	get compareFn(): (a: Version<TContext>, b: Version<TContext>) => number {
		return this.#compareFn;
	}

	/**
	 * Adds a new version to the migration registry.
	 * @param version - The version string (will be normalized to semver format).
	 * @param up - The upgrade function to execute when migrating up to this version.
	 * @param down - The downgrade function to execute when migrating down from
	 * this version. Pass `null` or `undefined` to mark the version as
	 * irreversible (one-way); in that case {@link down} and {@link uninstall}
	 * refuse any path that crosses this version.
	 * @param comment - Optional comment or description for this version.
	 * @returns The created Version instance.
	 * @throws {Error} If the version already exists.
	 */
	addVersion(
		version: string,
		up: MigrateFn<TContext>,
		down?: MigrateFn<TContext> | null,
		comment: string | undefined = undefined,
	): Version<TContext> {
		const _version = new Version<TContext>(version, up, down, comment, (...args) =>
			this.#log(...args),
		);

		// The internal collection does not assert, but we want to be strict here
		if (this.__versions.findById(_version.version)) {
			throw new Error(`Version already exists ("${version}")`);
		}

		this.#versions.add(_version);

		return _version;
	}

	/**
	 * Removes a version from the migration registry: an undo/redo history drops
	 * the undone ("pending") steps this way before a new action is recorded, and
	 * its oldest steps to cap its length.
	 *
	 * Queued behind any running {@link up} / {@link down} / {@link uninstall}.
	 *
	 * @param version - The version string or Version instance to remove.
	 * @returns `true` if removed, `false` if no such version is registered.
	 * @throws {Error} If the version is the active one (its marker would be orphaned).
	 */
	removeVersion(version: string | Version<TContext>): Promise<boolean> {
		return this.#serialize(async () => {
			const id =
				version instanceof Version ? version.version : normalizeSemver(version);
			const found = this.#versions.findById(id);
			if (!found) return false;

			if ((await this.getActiveVersion()) === id) {
				throw new Error(`Cannot remove the active version ("${id}")`);
			}

			this.#log("removeVersion:", id);
			return this.#versions.remove(found);
		});
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
		const read = this.#options.getActiveVersion;

		// No external system: the version lives in memory
		if (typeof read !== "function") return this.#versions.active?.version;

		const raw = await read(this.context);
		const version = raw ? normalizeSemver(raw) : undefined;
		this.#syncActive(version);
		return version;
	}

	/**
	 * Sets the currently active version.
	 *
	 * The external `setActiveVersion` option (if configured) is written first: when
	 * it throws, the in-memory active version is left where it was.
	 *
	 * @param version - The version to set as active. Can be a version string, Version instance, "latest", "initial", or undefined.
	 * @returns The newly set active version string, or undefined.
	 * @throws {Error} If the specified version does not exist.
	 */
	async setActiveVersion(
		version: "latest" | "initial" | undefined | string | Version<TContext>,
	): Promise<string | undefined> {
		// `undefined` marks the system as "uninstalled"
		let next: Version<TContext> | undefined;

		if (version !== undefined) {
			let id: string | undefined;

			if (version instanceof Version) {
				id = version.version;
			} else if (version === "latest") {
				id = this.available.at(-1);
			} else if (version === "initial") {
				id = this.available.at(0);
			} else {
				id = normalizeSemver(version);
			}

			// Provided version must exist
			next = id ? this.#versions.findById(id) : undefined;
			if (!next) {
				throw new Error(`Version not found ("${version}")`);
			}
		}

		// Maybe save to external system
		await this.#options.setActiveVersion?.(next?.version, this.context);

		// Sync to instance
		if (next) {
			this.#versions.setActive(next);
		} else {
			this.#versions.unsetActive();
		}

		this.#log("setActiveVersion:", next?.version);

		return next?.version;
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
		await this.#options.setActiveVersion?.(normalized, this.context);
		this.#syncActive(normalized);
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
	findVersion(version: string, assert = false): Version<TContext> | undefined {
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
	 * @param given - The starting version. Left out, the current active version is read;
	 * given as `undefined`, nothing is taken as installed.
	 * @returns Metadata about the upgrade path, or undefined if no versions exist.
	 */
	async __upMeta(
		target: "latest" | "major" | "minor" | "patch" | string = "latest",
		...given: [fromVersionLabel?: string | undefined]
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

		// A caller that already read the active version passes it on, also when it is
		// `undefined`: reading it again would be a second round trip to the store
		const fromVersionLabel = given.length ? given[0] : await this.getActiveVersion();
		const isInitial = fromVersionLabel === undefined;
		const from = fromVersionLabel
			? this.findVersion(fromVersionLabel, true)!
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
			toVersion =
				this.#versions.items
					.filter(
						(v) =>
							v.major === from.major &&
							compareSemver(v.version, from.version) > 0,
					)
					.map((v) => v.version)
					.at(-1) ?? from.version;
		} //
		else if (target === "patch") {
			toVersion =
				this.#versions.items
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
		return this.#run("up", target);
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
			toVersion =
				this.#versions.items
					.filter(
						(v) =>
							v.major < from.major &&
							compareSemver(v.version, from.version) < 0,
					)
					.map((v) => v.version)
					.at(-1) ?? from.version;
		} //
		else if (target === "minor") {
			toVersion =
				this.#versions.items
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
			toVersion =
				this.#versions.items
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
	 *
	 * A path that crosses an irreversible version is refused before any of it runs.
	 *
	 * @param target - The target version or semver decrement ("initial", "major", "minor", "patch", or specific version).
	 * @returns The number of migration steps executed.
	 * @throws {Error} If there is no active version, target is not found, the path
	 * crosses an irreversible version, or if a migration fails.
	 */
	down(
		target: "initial" | "major" | "minor" | "patch" | string = "major",
	): Promise<number> {
		return this.#run("down", target);
	}

	/**
	 * Performs a complete uninstall by downgrading from the initial version to a blank slate.
	 * This is a special case that removes even the initial version.
	 *
	 * Refused before any of it runs when a version on the path (the initial one
	 * included) is irreversible.
	 *
	 * @returns The number of migration steps executed.
	 * @throws {Error} If the uninstall operation fails.
	 */
	uninstall(): Promise<number> {
		return this.#run("uninstall", undefined);
	}

	/**
	 * The one path every {@link up} / {@link down} / {@link uninstall} takes: queued
	 * behind the instance's other operations, inside the `wrapRun` hook, it computes
	 * the plan and executes it. The active version is read inside the hook, so a
	 * lock taken there covers it.
	 */
	#run(operation: RunInfo["operation"], target: string | undefined): Promise<number> {
		return this.#serialize(() => {
			const hook = this.#options.wrapRun;
			return this.#wrap(
				"wrapRun",
				target === undefined ? `${operation}()` : `${operation}("${target}")`,
				hook && ((run) => hook(run, { operation, target }, this.context)),
				async () => this.#execute(await this.plan(operation, target)),
			);
		});
	}

	/** Executes a plan as {@link plan} computed it, step by step. */
	async #execute(plan: Plan): Promise<number> {
		const { direction, steps, fromVersion, toVersion } = plan;

		if (!steps.length) {
			this.#log(`Nothing to do (at "${fromVersion}", target "${toVersion}")`);
			return 0;
		}

		// A rollback known to be impossible is refused as a whole: stopping halfway,
		// at the first version without a `down`, would leave a partial downgrade.
		if (direction === "down") {
			const blocked = steps
				.filter((s) => !s.reversible)
				.map((s) => `"${s.version}"`);
			if (blocked.length) {
				throw new Error(
					this.#log(
						`Unable to downgrade from "${fromVersion}": ` +
							(blocked.length > 1
								? `versions ${blocked.join(", ")} are`
								: `version ${blocked[0]} is`) +
							` irreversible (no down worker registered). Nothing was changed.`,
					),
				);
			}
		}

		this.#log(`--> Plan: "${fromVersion}" -> "${toVersion}"`);

		let successCounter = 0;
		for (const step of steps) {
			await this.#runStep(direction, step);
			successCounter++;
			this.#log(`OK "${step.activeAfter}"`);
		}

		this.#log(`--> ✔ Done in ${successCounter} steps`);

		return successCounter;
	}

	/**
	 * Runs a single step inside the `wrapStep` hook: the version's worker, then the
	 * write of the active version.
	 */
	async #runStep(direction: "up" | "down", step: PlanStep): Promise<void> {
		// Looked up by id, not by the index the plan was computed with: the
		// registry may have changed since
		const version = this.#versions.findById(step.version);
		if (!version) {
			throw new Error(
				`Version not found ("${step.version}"): removed while the run was in progress?`,
			);
		}

		const isUp = direction === "up";
		const before = this.#versions.active?.version;

		this.#log(
			isUp
				? `--> Upgrading from "${before}" to "${step.version}" ...`
				: `--> Downgrading from "${step.version}" to "${step.activeAfter}" ...`,
		);

		const hook = this.#options.wrapStep;

		try {
			await this.#wrap(
				"wrapStep",
				`the ${direction} step of version "${step.version}"`,
				hook && ((run) => hook(run, { ...step, direction }, this.context)),
				async () => {
					try {
						await (isUp
							? version.up(this.context)
							: version.down(this.context));
					} catch (e) {
						throw new Error(
							(isUp
								? `The upgrade to version "${step.version}" failed`
								: `The downgrade from version "${step.version}" failed`) +
								` (Details: ${e})`,
							{ cause: e },
						);
					}

					try {
						await this.setActiveVersion(step.activeAfter);
					} catch (e) {
						const [did, done] = isUp
							? ["upgrade", "upgraded"]
							: ["downgrade", "downgraded"];
						throw new Error(
							`The ${did} operation succeeded, but was unable to save the ${done} ` +
								`version "${step.activeAfter}". System may be unstable. You should ` +
								`manually fix the version before continuing. (Details: ${e})`,
							{ cause: e },
						);
					}
				},
			);
		} catch (e) {
			// A failed step leaves the in-memory marker where it was
			this.#syncActive(before);
			throw e;
		}
	}

	/**
	 * Produces the ordered list of steps that {@link up}, {@link down} or
	 * {@link uninstall} would execute, without running any migration function or
	 * mutating any state. The three run exactly what this returns. Useful for
	 * dry-runs, UIs and tests.
	 *
	 * @param operation - "up", "down" or "uninstall".
	 * @param target - Semver keyword ("latest"/"major"/"minor"/"patch" for up;
	 * "initial"/"major"/"minor"/"patch" for down) or a specific version. Ignored
	 * for "uninstall".
	 * @returns A {@link Plan} describing the computed path. An uninstall is a
	 * "down" plan whose last step leaves no active version.
	 * @throws {Error} If the target cannot be resolved, or for `down` when
	 * there is no active version.
	 */
	async plan(operation: "up" | "down" | "uninstall", target?: string): Promise<Plan> {
		if (operation !== "up" && operation !== "down" && operation !== "uninstall") {
			throw new TypeError(`Invalid plan operation "${operation}"`);
		}

		const active = await this.getActiveVersion();
		const steps: PlanStep[] = [];
		const addStep = (index: number, activeAfter: string | undefined) => {
			const v = this.#versions.at(index)!;
			steps.push({ version: v.version, activeAfter, reversible: v.isReversible });
		};

		if (operation === "up") {
			target ??= "latest";
			const meta = await this.__upMeta(target, active);
			if (!meta || meta.fromIndex === -1 || meta.toIndex === -1) {
				throw new Error(
					this.#log(`Unable to find matching up version for "${target}"`),
				);
			}

			// "from" is exclusive (unless nothing is installed yet), "to" is inclusive
			const first = meta.isInitial ? meta.fromIndex : meta.fromIndex + 1;
			for (let i = first; i <= meta.toIndex; i++) {
				addStep(i, this.#versions.at(i)!.version);
			}

			return {
				direction: "up",
				fromVersion: active,
				toVersion: meta.toVersion,
				steps,
			};
		}

		if (operation === "uninstall") {
			// Nothing installed, nothing to uninstall
			const fromIndex =
				active === undefined
					? -1
					: this.indexOf(this.findVersion(active, true)!.version);

			// All the way down: the initial version's own `down` runs as well, and
			// leaves no active version behind
			for (let i = fromIndex; i >= 0; i--) {
				addStep(i, i > 0 ? this.#versions.at(i - 1)!.version : undefined);
			}

			return {
				direction: "down",
				fromVersion: active,
				toVersion: undefined,
				steps,
			};
		}

		if (!active) {
			throw new Error("Cannot downgrade from undefined version");
		}

		target ??= "major";
		const meta = await this.__downMeta(target, active);
		if (!meta || meta.fromIndex === -1 || meta.toIndex === -1) {
			throw new Error(
				this.#log(`Unable to find matching down version for "${target}"`),
			);
		}

		// "from" is inclusive (its `down` is what runs), "to" is exclusive (it stays)
		for (let i = meta.fromIndex; i > meta.toIndex; i--) {
			addStep(i, this.#versions.at(i - 1)!.version);
		}

		return {
			direction: "down",
			fromVersion: active,
			toVersion: meta.toVersion,
			steps,
		};
	}

	/**
	 * Produces a status snapshot.
	 * @returns Current active version, latest known version, whether we are at
	 * the latest, and the list of pending version strings: the registered ones
	 * strictly above the active version by semver order, also when the active
	 * version itself is not registered.
	 */
	async status(): Promise<Status> {
		const active = await this.getActiveVersion();
		const all = this.available;
		const latest = all.at(-1);
		return {
			active,
			latest,
			isAtLatest: active !== undefined && active === latest,
			pending:
				active === undefined
					? all
					: all.filter((v) => compareSemver(v, active) > 0),
		};
	}
}
