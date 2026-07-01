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

/**
 * postgres/mysql 연결 문자열을 해석한다. 우선순위:
 *   1. platform.env.HYPERDRIVE.connectionString  (Cloudflare Workers + Hyperdrive)
 *   2. platform.env.DATABASE_URL                  (Workers 에서 Hyperdrive 없이 직결 — var/secret)
 *   3. process.env.DATABASE_URL                   (순수 Node 환경)
 * 이 순서 덕분에 Workers(Hyperdrive/직결)와 Node 환경을 모두 지원한다.
 */
function resolveConnectionString(platform: App.Platform | undefined, dialect: string): string {
    const fromHyperdrive = platform?.env?.HYPERDRIVE?.connectionString;
    if (fromHyperdrive) return fromHyperdrive;

    const platformEnv = platform?.env as Record<string, unknown> | undefined;
    const fromPlatformUrl = platformEnv?.DATABASE_URL;
    if (typeof fromPlatformUrl === "string" && fromPlatformUrl.length > 0) return fromPlatformUrl;

    const fromNodeEnv = typeof process !== "undefined" ? process.env?.DATABASE_URL : undefined;
    if (fromNodeEnv && fromNodeEnv.length > 0) return fromNodeEnv;

    throw new Error(
        `DB_DIALECT=${dialect} 연결 문자열을 찾을 수 없습니다. Cloudflare 에서는 HYPERDRIVE 바인딩(또는 DATABASE_URL var/secret), 순수 Node 환경에서는 DATABASE_URL 환경변수를 설정하세요.`,
    );
}

/**
 * 활성 방언에 맞는 drizzle 인스턴스를 반환한다.
 * - d1:       platform.env.DB (D1 바인딩, Workers 전용), 요청마다 FK 제약 활성화(PRAGMA).
 * - postgres: Hyperdrive / DATABASE_URL → postgres-js.
 * - mysql:    Hyperdrive / DATABASE_URL → mysql2.
 */
export async function getDb(platform: App.Platform | undefined): Promise<DB> {
    if (__DB_DIALECT__ === "postgres") {
        const connectionString = resolveConnectionString(platform, "postgres");
        const { drizzle } = await import("drizzle-orm/postgres-js");
        const postgres = (await import("postgres")).default;
        if (!pgSql) {
            // Hyperdrive 뒤에서는 fetch_types 조회가 불필요/불가하므로 비활성화.
            pgSql = postgres(connectionString, { max: 5, fetch_types: false });
        }
        return drizzle(pgSql as never, { schema: schema as never }) as unknown as DB;
    }

    if (__DB_DIALECT__ === "mysql") {
        const connectionString = resolveConnectionString(platform, "mysql");
        const { drizzle } = await import("drizzle-orm/mysql2");
        const mysql = (await import("mysql2/promise")).default;
        if (!mysqlPool) {
            mysqlPool = mysql.createPool({ uri: connectionString, connectionLimit: 5 });
        }
        return drizzle(mysqlPool as never, { schema: schema as never, mode: "default" }) as unknown as DB;
    }

    if (__DB_DIALECT__ === "d1" || typeof __DB_DIALECT__ === "undefined") {
        // Cloudflare D1 (Workers 전용)
        if (!platform?.env?.DB) {
            throw new Error(
                'D1 binding "DB" is not available. D1 은 Cloudflare Workers 전용입니다. 순수 Node 환경(adapter-node)에서는 DB_DIALECT=postgres 또는 mysql 을 사용하세요. Workers 라면 wrangler.jsonc 와 platform.env 를 확인하세요.',
            );
        }
        const { drizzle } = await import("drizzle-orm/d1");
        const db = drizzle(platform.env.DB, { schema: schema as never });
        // D1(SQLite)은 연결마다 FK 제약이 비활성화됨 — 매 요청에 명시적으로 활성화
        await db.run(sql`PRAGMA foreign_keys = ON`);
        return db as unknown as DB;
    }

    throw new Error(`Unknown DB_DIALECT: ${String(__DB_DIALECT__)}`);
}
