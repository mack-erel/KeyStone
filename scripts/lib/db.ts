/**
 * 스크립트(node/bun)용 방언-인식 DB 헬퍼.
 *
 * 앱 런타임의 `getDb` 는 Cloudflare Workers(platform.env) 전제라 스크립트에서 못 쓴다.
 * 이 모듈은 `DB_DIALECT` 에 맞는 drizzle 인스턴스를 순수 node 환경에서 만들어 준다:
 *   - postgres : postgres-js  + DATABASE_URL
 *   - mysql    : mysql2       + DATABASE_URL
 *   - sqlite   : @libsql/client + DATABASE_URL(file:/libsql:/http:)
 *   - d1       : drizzle-orm/sqlite-proxy 로 Cloudflare D1 REST(/raw) 래핑
 *               (node 에는 D1 바인딩이 없으므로 HTTP 로 대체)
 *
 * 스키마는 활성 방언 파일을 동적 import 한다(빌드 alias `$db-active-schema` 불필요).
 * 세 방언 스키마는 테이블/컬럼/JS 키가 동일하므로 시드 로직은 한 번만 작성하면 된다.
 */

export type Dialect = "d1" | "sqlite" | "postgres" | "mysql";

export interface ScriptDb {
    dialect: Dialect;
    /** 활성 방언 drizzle 인스턴스 (schema 바인딩됨). 시드/쿼리에 사용. */
    // 방언마다 drizzle 인스턴스 타입이 달라(pg/mysql/sqlite/proxy) loose 하게 둔다.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: any;
    /** 활성 방언 스키마 배럴 (테이블 객체). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema: Record<string, any>;
    /** 여러 문장이 포함된 raw SQL 을 실행한다(마이그레이션 파일 적용용). */
    execRaw(sqlText: string): Promise<void>;
    /** 단일 SELECT 를 실행해 객체 배열을 돌려준다(방언 무관 표 조회). */
    queryRows<T = Record<string, unknown>>(sqlText: string, params?: unknown[]): Promise<T[]>;
    /** 사용자 테이블 이름 목록(마이그레이션/시드 추적 테이블 제외). */
    listUserTables(): Promise<string[]>;
    close(): Promise<void>;
}

function readEnv(key: string): string | undefined {
    const v = process.env[key];
    return v && v.length > 0 ? v : undefined;
}

export function resolveDialect(): Dialect {
    const d = (process.env.DB_DIALECT || "d1").toLowerCase();
    if (d === "postgres" || d === "mysql" || d === "sqlite" || d === "d1") return d;
    throw new Error(`Unknown DB_DIALECT: ${d}`);
}

function requireDatabaseUrl(dialect: Dialect): string {
    const url = readEnv("DATABASE_URL");
    if (!url) throw new Error(`DB_DIALECT=${dialect} 에는 DATABASE_URL 이 필요합니다. .env 를 확인하세요.`);
    return url;
}

// ─── postgres ────────────────────────────────────────────────────────────────
async function createPg(): Promise<ScriptDb> {
    const url = requireDatabaseUrl("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const postgres = (await import("postgres")).default;
    const schema = await import("../../src/lib/server/db/schema.pg");
    const client = postgres(url, { max: 1, fetch_types: false });
    const db = drizzle(client, { schema: schema as never });
    return {
        dialect: "postgres",
        db,
        schema: schema as never,
        async execRaw(sqlText) {
            await client.unsafe(sqlText);
        },
        async queryRows(sqlText, params = []) {
            return (await client.unsafe(sqlText, params as never[])) as never;
        },
        async listUserTables() {
            const rows = await client<{ tablename: string }[]>`
                SELECT tablename FROM pg_tables
                WHERE schemaname = 'public'
                  AND tablename NOT IN ('__drizzle_migrations', '_seed_migrations')
                ORDER BY tablename`;
            return rows.map((r) => r.tablename);
        },
        async close() {
            await client.end({ timeout: 5 });
        },
    };
}

// ─── mysql ───────────────────────────────────────────────────────────────────
async function createMysql(): Promise<ScriptDb> {
    const url = requireDatabaseUrl("mysql");
    const { drizzle } = await import("drizzle-orm/mysql2");
    const mysql = (await import("mysql2/promise")).default;
    const schema = await import("../../src/lib/server/db/schema.mysql");
    const pool = mysql.createPool({ uri: url, connectionLimit: 2, multipleStatements: true });
    const db = drizzle(pool, { schema: schema as never, mode: "default" });
    return {
        dialect: "mysql",
        db,
        schema: schema as never,
        async execRaw(sqlText) {
            await pool.query(sqlText);
        },
        async queryRows(sqlText, params = []) {
            const [rows] = await pool.query(sqlText, params);
            return rows as never;
        },
        async listUserTables() {
            const [rows] = (await pool.query(
                `SELECT table_name AS name FROM information_schema.tables
                 WHERE table_schema = DATABASE()
                   AND table_name NOT IN ('__drizzle_migrations', '_seed_migrations')
                 ORDER BY table_name`,
            )) as unknown as [{ name: string }[]];
            return rows.map((r) => r.name);
        },
        async close() {
            await pool.end();
        },
    };
}

// ─── sqlite (libSQL) ───────────────────────────────────────────────────────────
async function createSqlite(): Promise<ScriptDb> {
    const raw = requireDatabaseUrl("sqlite");
    const url = /^(file:|libsql:|https?:|wss?:)/.test(raw) ? raw : `file:${raw}`;
    const { drizzle } = await import("drizzle-orm/libsql");
    const { createClient } = await import("@libsql/client");
    const schema = await import("../../src/lib/server/db/schema.sqlite");
    const client = createClient({ url, authToken: readEnv("DATABASE_AUTH_TOKEN") ?? readEnv("SQLITE_AUTH_TOKEN") });
    const db = drizzle(client, { schema: schema as never });
    return {
        dialect: "sqlite",
        db,
        schema: schema as never,
        async execRaw(sqlText) {
            await client.executeMultiple(sqlText);
        },
        async queryRows(sqlText, params = []) {
            const res = await client.execute({ sql: sqlText, args: params as never[] });
            return res.rows as never;
        },
        async listUserTables() {
            const res = await client.execute(
                `SELECT name FROM sqlite_master WHERE type='table'
                 AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
                 AND name NOT IN ('__drizzle_migrations', '_seed_migrations') ORDER BY name`,
            );
            return res.rows.map((r) => String((r as Record<string, unknown>).name));
        },
        async close() {
            client.close();
        },
    };
}

// ─── d1 (sqlite-proxy over REST) ───────────────────────────────────────────────
function d1Rest() {
    const isPreview = process.env.CLOUDFLARE_IS_PREVIEW === "true";
    const accountId = readEnv("CLOUDFLARE_ACCOUNT_ID");
    const token = readEnv("CLOUDFLARE_D1_TOKEN") ?? readEnv("CLOUDFLARE_API_TOKEN");
    const databaseId = isPreview ? readEnv("CLOUDFLARE_D1_PREVIEW_DATABASE_ID") : readEnv("CLOUDFLARE_D1_DATABASE_ID");
    const missing: string[] = [];
    if (!accountId) missing.push("CLOUDFLARE_ACCOUNT_ID");
    if (!token) missing.push("CLOUDFLARE_API_TOKEN(또는 CLOUDFLARE_D1_TOKEN)");
    if (!databaseId) missing.push(isPreview ? "CLOUDFLARE_D1_PREVIEW_DATABASE_ID" : "CLOUDFLARE_D1_DATABASE_ID");
    if (missing.length > 0) throw new Error(`D1 REST 접근에 필요한 환경변수 누락: ${missing.join(", ")}`);
    const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    /** /raw: rows 를 배열(값 순서)로 돌려준다 — sqlite-proxy 가 기대하는 형식. */
    async function raw(sql: string, params: unknown[] = []): Promise<{ columns: string[]; rows: unknown[][] }> {
        const res = await fetch(`${base}/raw`, { method: "POST", headers, body: JSON.stringify({ sql, params }) });
        const data = (await res.json()) as { success: boolean; errors: unknown[]; result: [{ results: { columns: string[]; rows: unknown[][] } }] };
        if (!data.success) throw new Error(`D1 SQL 실패: ${JSON.stringify(data.errors)}\nSQL: ${sql}`);
        return data.result[0]?.results ?? { columns: [], rows: [] };
    }
    return { base, headers, raw };
}

async function createD1(): Promise<ScriptDb> {
    const rest = d1Rest();
    const { drizzle } = await import("drizzle-orm/sqlite-proxy");
    const schema = await import("../../src/lib/server/db/schema.sqlite");
    const db = drizzle(
        async (sql: string, params: unknown[], method: "all" | "run" | "get" | "values") => {
            const { rows } = await rest.raw(sql, params);
            if (method === "get") return { rows: rows[0] ?? [] };
            // all / values / run 모두 배열의 배열(값 순서) 반환
            return { rows };
        },
        { schema: schema as never },
    );
    return {
        dialect: "d1",
        db,
        schema: schema as never,
        async execRaw(sqlText) {
            // D1 은 단일 문장 실행 — 세미콜론 기준으로 분리해 순차 실행.
            for (const stmt of splitSql(sqlText)) await rest.raw(stmt);
        },
        async queryRows(sqlText, params = []) {
            const { columns, rows } = await rest.raw(sqlText, params);
            return rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]]))) as never;
        },
        async listUserTables() {
            const { columns, rows } = await rest.raw(
                `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('__drizzle_migrations', '_seed_migrations') ORDER BY name`,
            );
            const nameIdx = columns.indexOf("name");
            return rows.map((r) => String(r[nameIdx]));
        },
        async close() {
            /* HTTP — 닫을 연결 없음 */
        },
    };
}

/** 세미콜론 기준으로 SQL 문장을 분리(단순 파서 — 문자열 리터럴 내 세미콜론 미고려). */
export function splitSql(content: string): string[] {
    return content
        .split(/;\s*$/m)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("--"));
}

/** 활성 DB_DIALECT 에 맞는 스크립트용 DB 핸들을 생성한다. */
export async function openScriptDb(): Promise<ScriptDb> {
    const dialect = resolveDialect();
    switch (dialect) {
        case "postgres":
            return createPg();
        case "mysql":
            return createMysql();
        case "sqlite":
            return createSqlite();
        case "d1":
            return createD1();
    }
}
