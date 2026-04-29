/**
 * Idempotent seed migrator — `seed/db/NNNN_*.sql` 의 미적용 파일만 순서대로 실행한다.
 * `_seed_migrations` 테이블로 적용 여부를 추적.
 *
 * 환경변수:
 * - CLOUDFLARE_ACCOUNT_ID
 * - CLOUDFLARE_API_TOKEN  (or CLOUDFLARE_D1_TOKEN)
 * - CLOUDFLARE_D1_DATABASE_ID  (or CLOUDFLARE_D1_PREVIEW_DATABASE_ID + CLOUDFLARE_IS_PREVIEW=true)
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isPreview = process.env.CLOUDFLARE_IS_PREVIEW === 'true';
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_D1_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
const DB_ID = isPreview
    ? process.env.CLOUDFLARE_D1_PREVIEW_DATABASE_ID
    : process.env.CLOUDFLARE_D1_DATABASE_ID;

const missing: string[] = [];
if (!ACCOUNT_ID) missing.push('CLOUDFLARE_ACCOUNT_ID');
if (!API_TOKEN) missing.push('CLOUDFLARE_API_TOKEN');
if (!DB_ID)
    missing.push(isPreview ? 'CLOUDFLARE_D1_PREVIEW_DATABASE_ID' : 'CLOUDFLARE_D1_DATABASE_ID');

if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}`;
const HEADERS = { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' };
const MIGRATIONS_DIR = resolve(__dirname, '../seed/db');

async function query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const res = await fetch(`${BASE}/query`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ sql, params })
    });
    const data = (await res.json()) as {
        success: boolean;
        errors: unknown[];
        result: { results: Record<string, unknown>[] }[];
    };
    if (!data.success) throw new Error(JSON.stringify(data.errors));
    return data.result[0]?.results ?? [];
}

function parseSql(content: string): string[] {
    return content
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith('--'));
}

if (!existsSync(MIGRATIONS_DIR)) {
    console.log(`(seed) ${MIGRATIONS_DIR} 가 없습니다. 적용할 마이그레이션 없음.`);
    process.exit(0);
}

await query(`CREATE TABLE IF NOT EXISTS _seed_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  applied_at TEXT    NOT NULL DEFAULT (datetime('now'))
)`);

const applied = new Set(
    (await query('SELECT name FROM _seed_migrations ORDER BY id')).map((r) => r.name)
);

const pending = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !applied.has(f));

if (pending.length === 0) {
    console.log('✓ seed migrations up to date');
    process.exit(0);
}

console.log(`Applying ${pending.length} pending migration(s)...`);

for (const file of pending) {
    console.log(`  → ${file}`);
    const content = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const sql of parseSql(content)) {
        await query(sql);
    }
    await query('INSERT INTO _seed_migrations (name) VALUES (?)', [file]);
}

console.log('✓ done');
