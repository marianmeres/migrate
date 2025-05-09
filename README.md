# @marianmeres/migrate

A general-purpose extensible versioning framework for managing incremental, bi-directional changes.

Possible use cases may include: 
- db migrations, 
- undo/redo systems,
- progress change tracking,
- install/uninstall systems...

Under the hood it is essentially a collection of `up` and `down` callback pairs labeled with a semantic version string.

The support for semver is essential, as it allows upgrades or downgrades within
all 3 semver segments (major, minor, patch).

## Installation
```sh
deno add jsr:@marianmeres/migrate
```
```sh
npm install @marianmeres/migrate
```

## Usage
```js
import { Migrate } from '@marianmeres/migrate';
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
// Returns the number of success migration steps.
const count = await m.up('latest' | 'major' | 'minor' | 'patch' | version);
const count = await m.down('initial' | 'major' | 'minor' | 'patch' | version);

// special case downgrade, which will remove even the initial version
const count = await m.uninstall();

```

## DB migrate implementation example

See [example](./example/).


## Basic Progress Tracking (pseudo) Example

```js
const db = [];
let sequence = 1;

//
const app = new Migrate();

// creates wrapper which will do some work,
// and also internally saves a progress step version
const work = async (thing: string) => {
    // "up" (do the work)
    const up = () => {
        db.push(thing);
    };

    // "down" (revert the work)
    const down = () => {
        db.pop();
    };

    // do the thing now
    await up();

    // add the version into internal stack
    const ver = app.addVersion(`${sequence++}`, up, down);

    // mark current version as active
    await app.setActiveVersion(ver);
};

// first action marks the "initial" version (1.0.0)
await work("hey"); // 1.0.0
await work("ho"); // 2.0.0
await work("lets"); // 3.0.0
await work("go"); // 4.0.0

// check if the work was done
assertEquals(db, ["hey", "ho", "lets", "go"]);
assertEquals(await app.getActiveVersion(), "4.0.0");

// undo all steps in sequence (one step at a time)
// the below could be written as: `await progress.down("initial");`
let result: string | number = 0;
do {
    result = await app.down(); // one major step down
    if (typeof result === "string") throw new Error(result);
} while (result);

// we must be at the initial state (v1) (note, that this does not completely remove)
assertEquals(await app.getActiveVersion(), "1.0.0");
assertEquals(db, ["hey"]);

// now redo all steps in one call (internally still will do step-by-step)
await app.up("latest");
assertEquals(db, ["hey", "ho", "lets", "go"]);

// now go back to second version (step)
await app.down("v2"); // "v2" is semver normalized to "2.0.0"
assertEquals(await app.getActiveVersion(), "2.0.0");
assertEquals(db, ["hey", "ho"]);

// now try to go to some high version which does not exist
assertRejects(() => app.up("12.34.56"), "Unable to find");

// we are still in the last version
assertEquals(await app.getActiveVersion(), "2.0.0");
assertEquals(db, ["hey", "ho"]);

// now remove altogether
await app.uninstall();
assertEquals(await app.getActiveVersion(), undefined);
assertEquals(db, []);
```