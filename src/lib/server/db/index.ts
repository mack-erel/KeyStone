import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

export type DB = DrizzleD1Database<typeof schema>;

export function createDb(binding: D1Database): DB {
	return drizzle(binding, { schema });
}

export async function getDb(platform: App.Platform | undefined): Promise<DB> {
	if (!platform?.env?.DB) {
		throw new Error('D1 binding "DB" is not available. Check wrangler.jsonc and platform.env.');
	}
	const db = createDb(platform.env.DB);
	// D1(SQLite)은 연결마다 FK 제약이 비활성화됨 — 매 요청에 명시적으로 활성화
	await db.run(sql`PRAGMA foreign_keys = ON`);
	return db;
}
