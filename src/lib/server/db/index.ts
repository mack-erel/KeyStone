import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema';

export type DB = DrizzleD1Database<typeof schema>;

export function createDb(binding: D1Database): DB {
	return drizzle(binding, { schema });
}

export function getDb(platform: App.Platform | undefined): DB {
	if (!platform?.env?.DB) {
		throw new Error('D1 binding "DB" is not available. Check wrangler.jsonc and platform.env.');
	}
	return createDb(platform.env.DB);
}
