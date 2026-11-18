import pg from "pg";
import type { PgMigrateContext } from "../src/pg.ts";

// The DB_* variables come from `.env` (see .env.example), loaded by Node's
// `--env-file` flag; see the usage in db-migrate.ts.
export const pool = new pg.Pool({
	user: process.env.DB_USER,
	host: process.env.DB_HOST,
	port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
	database: process.env.DB_DATABASE,
	password: process.env.DB_PASSWORD,
});

/**
 * What every `up` and `down` receives: `{ client }`, the one connection of the run in
 * progress, inside the transaction of the step. See `createPgMigrate` in ../src/pg.ts.
 */
export type Context = PgMigrateContext<pg.PoolClient>;
