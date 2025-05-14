// deno-lint-ignore-file no-explicit-any

import pg from "npm:pg";
import dotenv from "npm:dotenv";

dotenv.config();

export const pool = new pg.Pool({
	user: Deno.env.get("DB_USER"),
	host: Deno.env.get("DB_HOST"),
	database: Deno.env.get("DB_DATABASE"),
	password: Deno.env.get("DB_PASSWORD"),
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
			`select version from __migrate__ order by id desc limit 1`
		);
		return rows[0]?.version ?? undefined; // we want undefined, not null here
	} catch (e) {
		throw e;
	} finally {
		client.release();
	}
}
