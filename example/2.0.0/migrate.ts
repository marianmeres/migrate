import type { Context } from "../_db.ts";

export async function up({ client }: Context) {
	await client.query(`
		create table baz (
			bat serial primary key
		);
	`);
}

export async function down({ client }: Context) {
	await client.query(`drop table baz`);
}
