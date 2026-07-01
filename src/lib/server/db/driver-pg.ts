import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

// DB_DIALECT="postgres" 일 때의 정규 DB 타입. schema 배럴은 활성 방언(pg)으로 해석된다.
export type DB = PostgresJsDatabase<typeof schema>;
