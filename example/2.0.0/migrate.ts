// deno-lint-ignore-file no-explicit-any

export async function up(ctx: any) {
	const client = await ctx.pool.connect();
	try {
		await client.query(`
            create table baz (
                bat serial primary key
            );    
        `);
	} catch (e) {
		throw e;
	} finally {
		client.release();
	}
}

export async function down(ctx: any) {
	const client = await ctx.pool.connect();
	try {
		await client.query(`drop table baz`);
	} catch (e) {
		throw e;
	} finally {
		client.release();
	}
}
