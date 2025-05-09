// deno-lint-ignore-file no-explicit-any

export async function up(ctx: any) {
	const client = await ctx.pool.connect();
	try {
		await client.query(`alter table foo add baz varchar(255)`);
	} catch (e) {
		throw e;
	} finally {
		client.release();
	}
}

export async function down(ctx: any) {
	const client = await ctx.pool.connect();
	try {
		await client.query(`alter table foo drop baz`);
	} catch (e) {
		throw e;
	} finally {
		client.release();
	}
}
