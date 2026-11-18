import pg from "pg";

// The DB_* variables come from `.env` (see .env.example), loaded by Node's
// `--env-file` flag; see the usage in db-migrate.ts.
export const pool = new pg.Pool({
	user: process.env.DB_USER,
	host: process.env.DB_HOST,
	database: process.env.DB_DATABASE,
	password: process.env.DB_PASSWORD,
});

/** Internal DRY */
async function ensure_version_table(client: any) {
	await client.query(`
		create table if not exists __migrate__ (
			id serial primary key,
			version varchar(255) null,
			created_at timestamp with time zone not null default now()
		);
	`);
}

/** Migrate option */
export async function setActiveVersion(version: string | undefined, ctx: any) {
	const client = await ctx.pool.connect();
	try {
		await ensure_version_table(client);
		await client.query(`insert into __migrate__ (version) values ($1)`, [
			version ?? null,
		]);
		return version;
	} catch (e) {
		throw e;
	} finally {
		client.release();
	}
}

/** Migrate option */
export async function getActiveVersion(context: any) {
	const client = await context.pool.connect();
	try {
		await ensure_version_table(client);
		const { rows } = await client.query(
			`select version from __migrate__ order by id desc limit 1`,
		);
		return rows[0]?.version ?? undefined; // we want undefined, not null here
	} catch (e) {
		throw e;
	} finally {
		client.release();
	}
}
