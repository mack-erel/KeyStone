import { sql } from "drizzle-orm";
import * as schema from "./schema";
import type { DB } from "$db-active-driver";

export { DB_DIALECT } from "./dialect";
export type { DbDialect } from "./dialect";

/**
 * 앱 전역에서 사용하는 정규(canonical) DB 타입.
 *
 * 활성 방언(DB_DIALECT)에 맞는 drizzle 인스턴스 타입으로, `$db-active-driver` alias
 * 를 통해 방언별 driver-*.ts 중 하나로 해석된다(활성 스키마 배럴과 짝을 이룸).
 * 덕분에 대부분의 쿼리 코드는 방언과 무관하게 그대로 컴파일된다. 방언마다 갈라지는
 * 소수의 호출부(onConflict / batch / returning)만 `DB_DIALECT` 로 런타임 분기한다.
 */
export type { DB };

// vite.config.ts 의 define 으로 빌드 시 리터럴로 치환됨. 이 리터럴 분기를 esbuild 가
// dead-code-elimination 하여, 워커 번들에는 활성 방언의 드라이버만 포함된다.
declare const __DB_DIALECT__: "d1" | "postgres" | "mysql" | undefined;

// postgres-js / mysql2 클라이언트는 isolate 전역에서 재사용해 Hyperdrive 연결
// 재사용을 극대화한다 (요청마다 새 연결을 열지 않는다).
let pgSql: unknown;
let mysqlPool: unknown;

function getHyperdriveConnectionString(platform: App.Platform | undefined, dialect: string): string {
    const conn = platform?.env?.HYPERDRIVE?.connectionString;
    if (!conn) {
        throw new Error(`Hyperdrive binding "HYPERDRIVE" is not available. DB_DIALECT=${dialect} 에는 Hyperdrive 바인딩이 필요합니다. wrangler.jsonc 의 hyperdrive 설정과 platform.env 를 확인하세요.`);
    }
    return conn;
}

/**
 * 활성 방언에 맞는 drizzle 인스턴스를 반환한다.
 * - d1:       platform.env.DB (D1 바인딩), 요청마다 FK 제약 활성화(PRAGMA).
 * - postgres: platform.env.HYPERDRIVE.connectionString → postgres-js.
 * - mysql:    platform.env.HYPERDRIVE.connectionString → mysql2.
 */
export async function getDb(platform: App.Platform | undefined): Promise<DB> {
    if (__DB_DIALECT__ === "postgres") {
        const connectionString = getHyperdriveConnectionString(platform, "postgres");
        const { drizzle } = await import("drizzle-orm/postgres-js");
        const postgres = (await import("postgres")).default;
        if (!pgSql) {
            // Hyperdrive 뒤에서는 fetch_types 조회가 불필요/불가하므로 비활성화.
            pgSql = postgres(connectionString, { max: 5, fetch_types: false });
        }
        return drizzle(pgSql as never, { schema: schema as never }) as unknown as DB;
    }

    if (__DB_DIALECT__ === "mysql") {
        const connectionString = getHyperdriveConnectionString(platform, "mysql");
        const { drizzle } = await import("drizzle-orm/mysql2");
        const mysql = (await import("mysql2/promise")).default;
        if (!mysqlPool) {
            mysqlPool = mysql.createPool({ uri: connectionString, connectionLimit: 5 });
        }
        return drizzle(mysqlPool as never, { schema: schema as never, mode: "default" }) as unknown as DB;
    }

    if (__DB_DIALECT__ === "d1" || typeof __DB_DIALECT__ === "undefined") {
        // Cloudflare D1 (기본)
        if (!platform?.env?.DB) {
            throw new Error('D1 binding "DB" is not available. Check wrangler.jsonc and platform.env.');
        }
        const { drizzle } = await import("drizzle-orm/d1");
        const db = drizzle(platform.env.DB, { schema: schema as never });
        // D1(SQLite)은 연결마다 FK 제약이 비활성화됨 — 매 요청에 명시적으로 활성화
        await db.run(sql`PRAGMA foreign_keys = ON`);
        return db as unknown as DB;
    }

    throw new Error(`Unknown DB_DIALECT: ${String(__DB_DIALECT__)}`);
}
