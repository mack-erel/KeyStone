import type { MySql2Database } from "drizzle-orm/mysql2";
import * as schema from "./schema";

// DB_DIALECT="mysql" 일 때의 정규 DB 타입. schema 배럴은 활성 방언(mysql)으로 해석된다.
export type DB = MySql2Database<typeof schema>;
