export async function up(ctx: any) {
	const client = await ctx.pool.connect();
	try {
		await client.query(`
            create table foo (
                bar serial primary key
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
		await client.query(`drop table foo`);
	} catch (e) {
		throw e;
	} finally {
		client.release();
	}
}
