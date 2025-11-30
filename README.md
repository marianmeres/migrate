# @marianmeres/migrate

[![NPM version](https://img.shields.io/npm/v/@marianmeres/migrate.svg)](https://www.npmjs.com/package/@marianmeres/migrate)
[![JSR version](https://jsr.io/badges/@marianmeres/migrate)](https://jsr.io/@marianmeres/migrate)

A general-purpose extensible versioning framework for managing incremental, bi-directional
changes.

Possible use cases may include:

- db migrations,
- undo/redo systems,
- progress change tracking,
- install/uninstall systems...

## How does it work?

Under the hood it is essentially an ordered collection of `up` and `down` callback pairs labeled
with a semantic version string (and every upgrade or downgrade is then a serial execution of
the relevant `up`'s or `down`'s).

## Installation

```sh
deno add jsr:@marianmeres/migrate
```

```sh
npm install @marianmeres/migrate
```

## Usage

```js
import { Migrate } from "@marianmeres/migrate";
```

## Main API

```typescript
// create instance
const m = new Migrate(
    options: {
        // provide current version's setter/getter (typically stored in a db)
        // if not provided, will keep the system version only in memory
        getActiveVersion: (context) => Promise<string | undefined>;
        setActiveVersion: (version, context) => Promise<string | undefined>;
    } = {}, 
    // arbitrary context which will be passed to each up/down step
    context, 
);

// add available versions with migration functions
m.addVersion('1.2.3', upFn, downFn);
m.addVersion('4.5.6', upFn, downFn);

// set/get the system's current version (which is initially undefined)
await m.setCurrentVersion('7.8.9');
const current = await m.getCurrentVersion();

// Migrate up or down from current to defined target.
// Will be a no-op if there's no available up/down match.
// Will throw if target does not exist.
// Returns the number of applied migration steps.
const count = await m.up('latest' | 'major' | 'minor' | 'patch' | version);
const count = await m.down('initial' | 'major' | 'minor' | 'patch' | version);

// special case downgrade, which will remove even the initial version
const count = await m.uninstall();
```

## DB migrate implementation example

See [deno script example](./example/). Can be run as, for example:

```sh
deno run example/db-migrate.ts --up --target=latest
deno run example/db-migrate.ts --down --target=1.1.0
deno run example/db-migrate.ts --uninstall
```

## Basic progress tracking (pseudo) example

```js
const db = []; // simulate external store
let sequence = 1;

//
const app = new Migrate();

// creates wrapper which will do some work, and save progress
const work = async (thing: string) => {
    // "up" (do the work)
    const up = () => {
        db.push(thing);
    };

    // "down" (revert the work)
    const down = () => {
        db.pop();
    };

    // do the work now
    await up();

    // save progress: add the version into internal stack
    const ver = app.addVersion(`${sequence++}`, up, down);

    // mark current version as active
    await app.setActiveVersion(ver);
};

//
await work("hey");  // 1.0.0 (this will become the "initial" version)
await work("ho");   // 2.0.0
await work("lets"); // 3.0.0
await work("go");   // 4.0.0

// check if the work was done
assertEquals(db, ["hey", "ho", "lets", "go"]);
assertEquals(await app.getActiveVersion(), "4.0.0");

// undo all steps (one step at a time)
// this could be written as: `await progress.down("initial");`
let result = 0;
do {
    result = await app.down(); // one major step down
} while (result);

// we must be at the initial state (note, that this does not completely remove all artifacts)
assertEquals(await app.getActiveVersion(), "1.0.0");
assertEquals(db, ["hey"]);

// now redo all steps (upgrade to "latest")
await app.up("latest");
assertEquals(db, ["hey", "ho", "lets", "go"]);

// now go back to specific version
await app.down("v2"); // "v2" is semver normalized to "2.0.0"
assertEquals(await app.getActiveVersion(), "2.0.0");
assertEquals(db, ["hey", "ho"]);

// now try to upgrade to unknown version
assertRejects(() => app.up("12.34.56"), "Unable to find");

// we are still in the last version
assertEquals(await app.getActiveVersion(), "2.0.0");
assertEquals(db, ["hey", "ho"]);

// now remove altogether
await app.uninstall();
assertEquals(await app.getActiveVersion(), undefined);
assertEquals(db, []);
```

## Package Identity

- **Name:** @marianmeres/migrate
- **Author:** Marian Meres
- **Repository:** https://github.com/marianmeres/migrate
- **License:** MIT
