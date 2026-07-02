/**
 * Idempotent seed migrator — `seed/db/NNNN_*.sql` 의 미적용 파일만 순서대로 실행한다.
 * `_seed_migrations` 테이블로 적용 여부를 추적. (방언 무관: d1 / sqlite / postgres / mysql)
 *
 * 활성 방언은 `DB_DIALECT`(기본 d1) 로 결정. 연결 정보는 방언별로 다르다:
 * - postgres/mysql/sqlite : DATABASE_URL
 * - d1                    : CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN(or _D1_TOKEN) /
 *                           CLOUDFLARE_D1_DATABASE_ID (CLOUDFLARE_IS_PREVIEW=true 면 PREVIEW)
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openScriptDb, type Dialect } from "./lib/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../seed/db");

// _seed_migrations 추적 테이블 DDL — 방언별 auto-increment/timestamp 문법 차이.
const TRACKING_DDL: Record<Dialect, string> = {
    d1: `CREATE TABLE IF NOT EXISTS _seed_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    sqlite: `CREATE TABLE IF NOT EXISTS _seed_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    postgres: `CREATE TABLE IF NOT EXISTS _seed_migrations (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    mysql: `CREATE TABLE IF NOT EXISTS _seed_migrations (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
};

async function main() {
    if (!existsSync(MIGRATIONS_DIR)) {
        console.log(`(seed) ${MIGRATIONS_DIR} 가 없습니다. 적용할 마이그레이션 없음.`);
        return;
    }

    const h = await openScriptDb();
    try {
        await h.execRaw(TRACKING_DDL[h.dialect]);

        const appliedRows = await h.queryRows<{ name: string }>(`SELECT name FROM _seed_migrations ORDER BY id`);
        const applied = new Set(appliedRows.map((r) => r.name));

        const pending = readdirSync(MIGRATIONS_DIR)
            .filter((f) => f.endsWith(".sql"))
            .sort()
            .filter((f) => !applied.has(f));

        if (pending.length === 0) {
            console.log(`✓ seed migrations up to date (dialect=${h.dialect})`);
            return;
        }

        console.log(`Applying ${pending.length} pending migration(s) [dialect=${h.dialect}]...`);
        for (const file of pending) {
            console.log(`  → ${file}`);
            const content = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
            await h.execRaw(content);
            // 파일명은 readdir 산출물이라 주입 위험 없음 — 작은따옴표만 이스케이프.
            await h.execRaw(`INSERT INTO _seed_migrations (name) VALUES ('${file.replace(/'/g, "''")}')`);
        }

        console.log("✓ done");
    } finally {
        await h.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
