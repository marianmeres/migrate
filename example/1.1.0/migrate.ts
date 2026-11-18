import type { Context } from "../_db.ts";

export async function up({ client }: Context) {
	await client.query(`alter table foo add baz varchar(255)`);
}

export async function down({ client }: Context) {
	await client.query(`alter table foo drop baz`);
}
