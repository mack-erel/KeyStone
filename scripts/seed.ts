/**
 * Keystone IdP — D1 seed 스크립트
 *
 * 모드:
 * - `ignore` (기본):  기존 데이터 보존, 누락된 기본값만 INSERT (idempotent)
 * - `replace`:       모든 사용자 테이블 DROP → drizzle 마이그레이션 재적용 → seed
 *
 * 환경변수:
 * - CLOUDFLARE_ACCOUNT_ID
 * - CLOUDFLARE_API_TOKEN  (또는 CLOUDFLARE_D1_TOKEN)
 * - CLOUDFLARE_D1_DATABASE_ID  (CLOUDFLARE_IS_PREVIEW=true 일 때는 PREVIEW)
 *
 * 선택 환경변수 (지정 시 admin 자동 생성):
 * - IDP_BOOTSTRAP_ADMIN_USERNAME, IDP_BOOTSTRAP_ADMIN_EMAIL,
 *   IDP_BOOTSTRAP_ADMIN_PASSWORD, IDP_BOOTSTRAP_ADMIN_NAME
 *
 * 사용:
 *   bun scripts/seed.ts                              # 운영
 *   CLOUDFLARE_IS_PREVIEW=true bun scripts/seed.ts   # 프리뷰
 */
import * as readline from "node:readline";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const isPreview = process.env.CLOUDFLARE_IS_PREVIEW === "true";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = isPreview ? process.env.CLOUDFLARE_D1_PREVIEW_DATABASE_ID : process.env.CLOUDFLARE_D1_DATABASE_ID;
const token = process.env.CLOUDFLARE_D1_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;

if (!accountId) {
    console.error("CLOUDFLARE_ACCOUNT_ID is required");
    process.exit(1);
}
if (!token) {
    console.error("CLOUDFLARE_API_TOKEN (or CLOUDFLARE_D1_TOKEN) is required");
    process.exit(1);
}
if (!databaseId) {
    console.error(isPreview ? "CLOUDFLARE_D1_PREVIEW_DATABASE_ID is required for preview mode" : "CLOUDFLARE_D1_DATABASE_ID is required");
    process.exit(1);
}

if (isPreview) {
    console.log(`[preview] using database: ${databaseId}`);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`;
const HEADERS = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

type Param = string | number | boolean | null;

async function q(sql: string, params: Param[] = []): Promise<void> {
    const res = await fetch(`${BASE}/raw`, { method: "POST", headers: HEADERS, body: JSON.stringify({ sql, params }) });
    const data = (await res.json()) as { success: boolean; errors: unknown[] };
    if (!data.success) throw new Error(`SQL failed: ${JSON.stringify(data.errors)}\nSQL: ${sql}`);
}

async function qRows<T extends Record<string, unknown>>(sql: string, params: Param[] = []): Promise<T[]> {
    const res = await fetch(`${BASE}/raw`, { method: "POST", headers: HEADERS, body: JSON.stringify({ sql, params }) });
    const data = (await res.json()) as {
        success: boolean;
        errors: unknown[];
        result: [{ results: { columns: string[]; rows: unknown[][] } }];
    };
    if (!data.success) throw new Error(`SQL failed: ${JSON.stringify(data.errors)}\nSQL: ${sql}`);
    const r = data.result[0]?.results;
    if (!r) return [];
    return r.rows.map((row) => Object.fromEntries(r.columns.map((col, i) => [col, row[i]])) as T);
}

function ask(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((res) => rl.question(question, (a) => (rl.close(), res(a.trim().toLowerCase()))));
}

function uuid(): string {
    return crypto.randomUUID();
}

// PBKDF2 — password.ts verifyPbkdf2 가 인식하는 형식: `pbkdf2$<digest>:<iter>$<saltB64>$<hashB64>`
async function hashPasswordPbkdf2(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, keyMaterial, 256);
    const saltB64 = btoa(String.fromCharCode(...salt));
    const hashB64 = btoa(String.fromCharCode(...new Uint8Array(derived)));
    return `pbkdf2$sha256:100000$${saltB64}$${hashB64}`;
}

// ─── reset (replace 모드) ────────────────────────────────────────────────────
async function resetDatabase(): Promise<void> {
    const tables = await qRows<{ name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT IN ('__drizzle_migrations', 'sqlite_sequence') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`,
    );
    const tableSet = new Set(tables.map((t) => t.name));

    // FK 의존성 위상정렬 — 자식 → 부모 순으로 DROP
    const deps = new Map<string, Set<string>>();
    for (const { name, sql } of tables) {
        const refs = new Set<string>();
        for (const m of (sql ?? "").matchAll(/REFERENCES\s+[`"]?(\w+)[`"]?/gi)) {
            if (tableSet.has(m[1]) && m[1] !== name) refs.add(m[1]);
        }
        deps.set(name, refs);
    }
    const inDegree = new Map<string, number>();
    for (const name of tableSet) inDegree.set(name, 0);
    for (const refs of deps.values()) for (const ref of refs) inDegree.set(ref, (inDegree.get(ref) ?? 0) + 1);

    const queue = [...tableSet].filter((n) => inDegree.get(n) === 0);
    const sorted: string[] = [];
    while (queue.length > 0) {
        const node = queue.shift()!;
        sorted.push(node);
        for (const parent of deps.get(node) ?? []) {
            const deg = (inDegree.get(parent) ?? 0) - 1;
            inDegree.set(parent, deg);
            if (deg === 0) queue.push(parent);
        }
    }
    for (const name of tableSet) if (!sorted.includes(name)) sorted.push(name);

    console.log(`  Dropping ${sorted.length} tables...`);
    for (const name of sorted) await q(`DROP TABLE IF EXISTS "${name}"`);
    await q(`DROP TABLE IF EXISTS "__drizzle_migrations"`);
    await q(`DROP TABLE IF EXISTS "_seed_migrations"`);
    console.log("  All tables dropped.");

    const drizzleDir = resolve(process.cwd(), "drizzle");
    const sqlFiles = readdirSync(drizzleDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();

    console.log(`Running ${sqlFiles.length} migration file(s)...`);
    for (const file of sqlFiles) {
        const content = readFileSync(join(drizzleDir, file), "utf-8");
        const statements = content
            .split("--> statement-breakpoint")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        for (const stmt of statements) await q(stmt);
        console.log(`  ${file} done`);
    }
}

// ─── seed (idempotent) ───────────────────────────────────────────────────────
async function seedDefaults(mode: "replace" | "ignore"): Promise<void> {
    const now = Date.now();

    // 1. 기본 tenant — slug='default'
    const tenants = await qRows<{ id: string }>(`SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`);
    let tenantId: string;
    if (tenants.length > 0) {
        tenantId = tenants[0].id;
        if (mode === "ignore") console.log(`  ✓ tenant 'default' already exists (id=${tenantId})`);
    } else {
        tenantId = uuid();
        await q(`INSERT INTO tenants (id, slug, name, status, created_at, updated_at) VALUES (?, 'default', 'Default', 'active', ?, ?)`, [tenantId, now, now]);
        console.log(`  + created tenant 'default' (id=${tenantId})`);
    }

    // 2. bootstrap admin (env 로 지정된 경우만)
    const adminUsername = process.env.IDP_BOOTSTRAP_ADMIN_USERNAME;
    const adminEmail = process.env.IDP_BOOTSTRAP_ADMIN_EMAIL;
    const adminPassword = process.env.IDP_BOOTSTRAP_ADMIN_PASSWORD;
    const adminName = process.env.IDP_BOOTSTRAP_ADMIN_NAME ?? "Admin";

    if (!(adminUsername && adminEmail && adminPassword)) {
        console.log("  · IDP_BOOTSTRAP_ADMIN_* 미설정 — admin 미생성. 'bun run setup' 또는 IdP UI 로 등록.");
        return;
    }

    const existing = await qRows<{ id: string }>(`SELECT id FROM users WHERE tenant_id = ? AND (username = ? OR email = ?) LIMIT 1`, [tenantId, adminUsername, adminEmail]);
    let userId: string;
    if (existing.length > 0) {
        userId = existing[0].id;
        console.log(`  ✓ admin user '${adminUsername}' already exists (id=${userId})`);
    } else {
        userId = uuid();
        await q(
            `INSERT INTO users (id, tenant_id, username, email, email_verified_at, display_name, role, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'admin', 'active', ?, ?)`,
            [userId, tenantId, adminUsername, adminEmail, now, adminName, now, now],
        );
        console.log(`  + created admin user '${adminUsername}' (id=${userId})`);
    }

    // 3. password credential
    const credExists = await qRows<{ id: string }>(`SELECT id FROM credentials WHERE user_id = ? AND type = 'password' LIMIT 1`, [userId]);
    if (credExists.length > 0) {
        console.log(`  ✓ password credential already exists`);
    } else {
        const credId = uuid();
        const hashed = await hashPasswordPbkdf2(adminPassword);
        await q(
            `INSERT INTO credentials (id, user_id, type, secret, label, created_at)
             VALUES (?, ?, 'password', ?, '비밀번호', ?)`,
            [credId, userId, hashed, now],
        );
        console.log(`  + created password credential`);
    }

    // 4. local identity
    const idExists = await qRows<{ id: string }>(`SELECT id FROM identities WHERE user_id = ? AND provider = 'local' LIMIT 1`, [userId]);
    if (idExists.length > 0) {
        console.log(`  ✓ local identity already exists`);
    } else {
        const identityId = uuid();
        await q(
            `INSERT INTO identities (id, tenant_id, user_id, provider, subject, email, linked_at)
             VALUES (?, ?, ?, 'local', ?, ?, ?)`,
            [identityId, tenantId, userId, adminEmail, adminEmail, now],
        );
        console.log(`  + created local identity`);
    }
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
    console.log("Seeding idp database...");

    const answer = await ask("기존 테이블을 모두 삭제하고 초기화하시겠습니까? (y/N): ");
    const shouldReset = answer === "y" || answer === "yes";

    if (shouldReset) {
        console.log("Resetting database...");
        await resetDatabase();
        await seedDefaults("replace");
    } else {
        console.log("Skipping existing data, inserting only new rows...");
        await seedDefaults("ignore");
    }

    console.log("✅ Seed complete!");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
