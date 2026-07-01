import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

// DB_DIALECT="sqlite" 일 때의 정규 DB 타입 (libSQL). schema 배럴은 sqlite 스키마로 해석된다.
export type DB = LibSQLDatabase<typeof schema>;
