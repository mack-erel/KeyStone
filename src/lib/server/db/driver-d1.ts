import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

// DB_DIALECT="d1" 일 때의 정규 DB 타입. schema 배럴은 활성 방언(여기선 sqlite)으로 해석된다.
export type DB = DrizzleD1Database<typeof schema>;
