import type { Context } from "../_db.ts";

export async function up({ client }: Context) {
	await client.query(`
		create table foo (
			bar serial primary key
		);
	`);
}

export async function down({ client }: Context) {
	await client.query(`drop table foo`);
}
