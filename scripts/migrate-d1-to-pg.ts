/**
 * D1(sqlite) → PostgreSQL 실데이터 이전 배치.
 *
 * Cloudflare D1(원격, sqlite 기반) 에 저장된 운영 데이터를 PostgreSQL 로 그대로 옮긴다.
 * 31개 테이블은 세 방언(schema.sqlite / schema.pg / schema.mysql)이 테이블·컬럼·JS 키까지
 * 100% 대칭이라, 값 변환은 **딱 두 종류**만 필요하다:
 *
 *   (a) timestamp — sqlite `integer{mode:"timestamp_ms"}`(정수 ms) → pg `timestamp{mode:"date"}`
 *       · 값:  ms(number)  →  new Date(ms).   NULL 은 NULL 유지.
 *   (b) boolean   — sqlite `integer{mode:"boolean"}`(0/1) → pg `boolean`
 *       · 값:  0 → false, 1 → true.           NULL 은 NULL 유지.
 *
 * 그 외(text/id/enum/JSON(text 저장)/정수/암호문/해시)는 **무변환 복사**한다.
 * 암호문·해시 컬럼(signing_keys.private_jwk_encrypted, credentials.secret, *_hash 등)은
 * IDP_SIGNING_KEY_SECRET 를 동일하게 유지하는 한 그대로 복사해도 복호/검증이 유지된다.
 * (이 스크립트는 시크릿을 건드리지 않는다. 시크릿 회전이 필요하면 reencrypt-secrets.ts 를 별도로.)
 *
 * ── 어떤 컬럼이 timestamp/boolean 인가? ─────────────────────────────────────────────
 * 하드코딩 목록 대신 drizzle 스키마 정의에서 **프로그래매틱하게 도출**한다.
 * `getTableColumns(table)` 로 각 컬럼의 `dataType` 을 읽어:
 *   · dataType === "date"    → timestamp 컬럼 (ms → Date 변환)
 *   · dataType === "boolean" → boolean 컬럼   (0/1 → bool 변환)
 * (검증됨: sqlite 의 timestamp_ms 는 columnType "SQLiteTimestamp"/dataType "date",
 *  boolean 은 "SQLiteBoolean"/dataType "boolean". pg 스키마도 동일 dataType 이라 어느
 *  쪽에서 도출해도 같지만, raw 인코딩 의미가 명확한 소스(sqlite) 스키마에서 도출한다.)
 * 스키마가 바뀌어도(컬럼 추가·삭제) 이 도출이 자동 추종하므로 drift 에 강하다.
 *
 * ── 읽기/쓰기/멱등성 ────────────────────────────────────────────────────────────────
 *   · 읽기: 소스(D1)에서 테이블별 `SELECT rowid, * ... WHERE rowid > ? ORDER BY rowid LIMIT n`
 *           커서 페이지네이션(대용량 audit_events / D1 REST 응답 크기 제한 대비).
 *   · 쓰기: pg drizzle `db.insert(pgTable).values(batch).onConflictDoNothing()` 배치(기본 500).
 *           onConflictDoNothing → PK 충돌 무시 = **재실행 안전(멱등)**.
 *   · FK 순서: 부모→자식 순으로 삽입(아래 TABLE_ORDER). departments 자기참조(parent_id)는
 *           parent 가 child 보다 먼저 오도록 위상정렬 후 삽입.
 *
 * ── 양쪽 DB 동시 연결 ───────────────────────────────────────────────────────────────
 * openScriptDb() 는 전역 DB_DIALECT 로 **하나**의 핸들만 연다. 소스(d1)·대상(postgres)
 * 두 핸들이 동시에 필요하므로, db.ts 를 건드리지 않고 process.env.DB_DIALECT 를 잠깐
 * 바꿔 openScriptDb() 를 두 번 호출한다(openDialect 헬퍼). 두 방언의 env 는 서로 겹치지
 * 않아 공존 가능하다:
 *   · 소스(d1):     CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_D1_DATABASE_ID /
 *                   CLOUDFLARE_API_TOKEN(또는 CLOUDFLARE_D1_TOKEN)
 *                   (CLOUDFLARE_IS_PREVIEW=true 면 CLOUDFLARE_D1_PREVIEW_DATABASE_ID)
 *   · 대상(postgres): DATABASE_URL
 *
 * ── 사용법 ────────────────────────────────────────────────────────────────────────
 *   # 1) 기본 = DRY-RUN (읽기·변환·건수 집계만, PG 에 아무것도 쓰지 않음)
 *   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_D1_DATABASE_ID=... CLOUDFLARE_API_TOKEN=... \
 *   DATABASE_URL='postgres://user:pass@host:5432/db' \
 *   bun scripts/migrate-d1-to-pg.ts
 *
 *   # 2) 실제 적용 (PG 쓰기) — 반드시 --apply 를 명시
 *   ...(동일 env)... bun scripts/migrate-d1-to-pg.ts --apply
 *
 *   # 옵션
 *   --dry-run            (기본) 읽기·변환·집계만. PG 미변경.
 *   --apply              실제 PG 쓰기.
 *   --skip-ephemeral     휘발성/단TTL 테이블 생략(아래 EPHEMERAL_TABLES). audit_events 는 보존.
 *   --only=a,b,c         지정 테이블만 이전(DB 테이블명, 콤마 구분).
 *   --tables-exclude=a,b 지정 테이블 제외.
 *   --batch-size=N       INSERT 배치 크기(기본 500).
 *   --page-size=N        SELECT 페이지 크기(기본 500).
 *   --disable-fk         (pg, 선택) 적용 중 `session_replication_role=replica` 로 FK/트리거
 *                        비활성화. 슈퍼유저/replication 권한 필요(Supabase 제한 계정은 실패 가능).
 *                        departments 위상정렬로 자기참조는 이미 안전하므로 보통 불필요.
 *
 * ── 안전 특성 ──────────────────────────────────────────────────────────────────────
 *   · 기본이 DRY-RUN. 실제 쓰기는 반드시 --apply.
 *   · 소스=d1, 대상=postgres 를 강제. 두 방언이 같으면 즉시 중단.
 *   · onConflictDoNothing 으로 멱등 — 중단 후 재실행해도 중복 삽입 없음.
 *   · 테이블별 scanned/inserted/skipped 로깅. 실패 시 어느 테이블·어느 배치(첫 행 id)에서
 *     실패했는지 보고하고 계속 진행(테이블 단위 격리)한다.
 *   · 이 스크립트는 **원격 PG 를 변경**할 수 있다 — 프로젝트 규칙상 자동 실행 금지.
 *     운영자가 env/대상 DB 를 직접 확인한 뒤 --apply 로 실행해야 한다.
 */
import { getTableColumns, getTableName } from "drizzle-orm";
import { openScriptDb, type ScriptDb } from "./lib/db";

// ── FK 부모→자식 삽입 순서 (schema export 키 = camelCase) ───────────────────────────
// 각 테이블이 참조하는 부모가 반드시 앞에 오도록 배열. 참조 관계:
//   users→tenants / credentials,identities,identityProviders,sessions→users,tenants /
//   oidcGrants,oidcRefreshTokens→users,sessions / samlSessions,samlSloStates→samlSps,users /
//   userServiceAssignments→serviceRoles,users / auditEvents→users / teams→departments,users /
//   userDepartments→departments,positions,users / parts→teams / userParts→parts /
//   userTeams→teams / *_tokens→users. departments.parent_id 는 자기참조(아래 위상정렬).
const TABLE_ORDER = [
    "tenants",
    "users",
    "credentials",
    "identities",
    "identityProviders",
    "sessions",
    "oidcClients",
    "oidcGrants",
    "oidcRefreshTokens",
    "samlSps",
    "samlSessions",
    "samlSloStates",
    "serviceRoles",
    "userServiceAssignments",
    "signingKeys",
    "auditEvents",
    "positions",
    "departments", // 자기참조(parent_id) → 위상정렬 후 삽입
    "teams",
    "userDepartments",
    "parts",
    "userParts",
    "userTeams",
    "samlAuthnRequestIds",
    "webauthnChallenges",
    "clientSkins",
    "rateLimits",
    "passwordResetTokens",
    "emailVerificationTokens",
    "inviteTokens",
    "emailChangeTokens",
] as const;

// --skip-ephemeral 로 생략할 휘발성/단TTL 테이블(DB 테이블명).
// sessions/oidc_refresh_tokens 는 로그인 지속에 필요하고 dangling FK 위험이 없어 보존한다
// (skip 대상 중 어떤 것도 보존 테이블에서 참조되지 않도록 구성). audit_events 는 절대 미포함.
const EPHEMERAL_TABLES = new Set<string>([
    "rate_limits",
    "webauthn_challenges",
    "oidc_grants",
    "saml_slo_states",
    "saml_authn_request_ids",
    "saml_sessions",
    "password_reset_tokens",
    "email_verification_tokens",
    "invite_tokens",
    "email_change_tokens",
]);

// ── 소스 컬럼 메타(변환 규칙) ────────────────────────────────────────────────────────
type ColKind = "timestamp" | "boolean" | "plain";
interface ColMeta {
    jsKey: string; // drizzle JS 프로퍼티명 (pg insert values 키)
    dbName: string; // DB 컬럼명 (snake_case, D1 SELECT 결과 키)
    kind: ColKind;
}

/** DB 테이블명 조회(스키마 객체가 any 라 getTableName 반환이 never 로 좁혀지는 것 방지). */
function tableName(table: unknown): string {
    return String(getTableName(table as never));
}

/** drizzle 테이블 정의에서 컬럼별 변환 규칙(timestamp/boolean/plain)을 도출한다. */
function deriveColumnMeta(table: unknown): ColMeta[] {
    const cols = getTableColumns(table as never) as Record<string, { name: string; dataType: string }>;
    const metas: ColMeta[] = [];
    for (const [jsKey, col] of Object.entries(cols)) {
        const kind: ColKind = col.dataType === "date" ? "timestamp" : col.dataType === "boolean" ? "boolean" : "plain";
        metas.push({ jsKey, dbName: col.name, kind });
    }
    return metas;
}

/**
 * D1 raw 행(snake_case 키·정수 인코딩) → pg insert 용 객체(camelCase 키·Date/boolean).
 * timestamp: ms → Date(null 유지). boolean: 0/1 → bool(null 유지). 그 외 무변환.
 * client_skins.createdAt 레거시 보정: 값이 초 단위(< 1e11)면 ×1000(스키마 주석 근거).
 */
function transformRow(raw: Record<string, unknown>, metas: ColMeta[], dbTable: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const m of metas) {
        const v = raw[m.dbName];
        if (v === null || v === undefined) {
            out[m.jsKey] = null;
            continue;
        }
        if (m.kind === "timestamp") {
            let ms = Number(v);
            // 레거시 초 단위 저장분(예: client_skins.createdAt) 보정. ms 단위 값은 항상
            // >= 1e11(2001-09 이후) 이므로, 그보다 작으면 초 단위로 보고 ×1000 한다.
            if (dbTable === "client_skins" && m.jsKey === "createdAt" && ms > 0 && ms < 1e11) {
                ms = ms * 1000;
            }
            out[m.jsKey] = new Date(ms);
        } else if (m.kind === "boolean") {
            out[m.jsKey] = v === 1 || v === "1" || v === true;
        } else {
            out[m.jsKey] = v;
        }
    }
    return out;
}

/** departments 위상정렬: parent 가 child 보다 먼저 오도록(자기참조 FK 만족). */
function topoSortDepartments(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    const byId = new Map<string, Record<string, unknown>>();
    for (const r of rows) byId.set(String(r.id), r);
    const sorted: Record<string, unknown>[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    function visit(r: Record<string, unknown>): void {
        const id = String(r.id);
        if (visited.has(id)) return;
        if (visiting.has(id)) return; // 이론상 없는 사이클 방어
        visiting.add(id);
        const parentId = r.parentId;
        if (parentId != null && byId.has(String(parentId))) {
            visit(byId.get(String(parentId))!);
        }
        visiting.delete(id);
        visited.add(id);
        sorted.push(r);
    }
    for (const r of rows) visit(r);
    return sorted;
}

// ── env / CLI ────────────────────────────────────────────────────────────────────

/** DB_DIALECT 를 잠깐 바꿔 특정 방언 핸들을 연다(원복 보장). db.ts 무수정 목적. */
async function openDialect(dialect: "d1" | "postgres"): Promise<ScriptDb> {
    const prev = process.env.DB_DIALECT;
    process.env.DB_DIALECT = dialect;
    try {
        return await openScriptDb();
    } finally {
        if (prev === undefined) delete process.env.DB_DIALECT;
        else process.env.DB_DIALECT = prev;
    }
}

function parseListFlag(args: string[], name: string): Set<string> | null {
    const prefix = `--${name}=`;
    const hit = args.find((a) => a.startsWith(prefix));
    if (!hit) return null;
    return new Set(
        hit
            .slice(prefix.length)
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
    );
}

function parseIntFlag(args: string[], name: string, fallback: number): number {
    const prefix = `--${name}=`;
    const hit = args.find((a) => a.startsWith(prefix));
    if (!hit) return fallback;
    const n = Number.parseInt(hit.slice(prefix.length), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface TableStat {
    scanned: number;
    inserted: number; // apply 시 INSERT 시도 건수(충돌 무시분 포함), dry-run 시 삽입 예정 건수
    skippedConflict: number; // (미집계 — onConflictDoNothing 은 개별 충돌 수를 돌려주지 않음)
}

// ── main ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const flags = new Set(args.filter((a) => !a.includes("=")));
    const apply = flags.has("--apply") || flags.has("--no-dry-run");
    if (flags.has("--dry-run") && apply) {
        console.error("✗ --dry-run 과 --apply 를 동시에 지정할 수 없습니다.");
        process.exit(1);
    }
    const skipEphemeral = flags.has("--skip-ephemeral");
    const disableFk = flags.has("--disable-fk");
    const only = parseListFlag(args, "only");
    const exclude = parseListFlag(args, "tables-exclude");
    const batchSize = parseIntFlag(args, "batch-size", 500);
    const pageSize = parseIntFlag(args, "page-size", 500);

    // ── 두 핸들 열기: 소스(d1) · 대상(postgres) ─────────────────────────────────────
    const source = await openDialect("d1");
    let target: ScriptDb;
    try {
        target = await openDialect("postgres");
    } catch (e) {
        await source.close();
        throw e;
    }

    console.log(`D1 → PG 데이터 이전 (source=${source.dialect}, target=${target.dialect}, mode=${apply ? "APPLY(PG 쓰기)" : "DRY-RUN(미변경)"})`);
    if (!apply) console.log("  ※ dry-run 입니다. 실제 적용하려면 --apply 를 붙이세요.");

    // 안전장치: 소스=d1, 대상=postgres 여야 한다(같은 방언이면 중단).
    if (source.dialect !== "d1") {
        await source.close();
        await target.close();
        console.error(`✗ 소스 방언이 d1 이 아닙니다: ${source.dialect}. 이 스크립트는 D1→PG 전용입니다.`);
        process.exit(1);
    }
    if (target.dialect !== "postgres") {
        await source.close();
        await target.close();
        console.error(`✗ 대상 방언이 postgres 가 아닙니다: ${target.dialect}. 이 스크립트는 D1→PG 전용입니다.`);
        process.exit(1);
    }
    // (소스 d1 · 대상 postgres 를 위에서 강제했으므로 두 방언이 같을 수 없다.)

    // 대상 이전 테이블 목록 계산(FK 순서 유지).
    const plannedTables = TABLE_ORDER.filter((key) => {
        const dbName = tableName(source.schema[key]);
        if (only && !only.has(dbName)) return false;
        if (exclude && exclude.has(dbName)) return false;
        if (skipEphemeral && EPHEMERAL_TABLES.has(dbName)) return false;
        return true;
    });

    console.log(`대상 테이블 ${plannedTables.length}/${TABLE_ORDER.length}개` + (skipEphemeral ? " (--skip-ephemeral 적용)" : "") + (only ? ` (--only)` : "") + (exclude ? ` (--tables-exclude)` : ""));

    const stats = new Map<string, TableStat>();
    const errors: string[] = [];

    try {
        if (apply && disableFk) {
            console.log("  --disable-fk: session_replication_role=replica 설정(적용 중 FK/트리거 비활성)");
            try {
                await target.execRaw("SET session_replication_role = replica");
            } catch (e) {
                console.error(`  ⚠ session_replication_role 설정 실패(권한 부족 가능): ${e instanceof Error ? e.message : e}. 계속 진행합니다.`);
            }
        }

        for (const key of plannedTables) {
            const sourceTable = source.schema[key];
            const targetTable = target.schema[key];
            const dbName = tableName(sourceTable);
            const metas = deriveColumnMeta(sourceTable);
            const stat: TableStat = { scanned: 0, inserted: 0, skippedConflict: 0 };
            stats.set(dbName, stat);

            // departments 는 자기참조 → 전량 수집 후 위상정렬해 부모부터 삽입.
            const collectAll = dbName === "departments";
            const collected: Record<string, unknown>[] = [];

            try {
                let cursor = 0;
                // rowid 커서 페이지네이션(모든 테이블에 존재하는 암묵 rowid 사용 — WITHOUT ROWID 테이블 없음).
                for (;;) {
                    const page = await source.queryRows<Record<string, unknown>>(`SELECT rowid AS _rowid, * FROM "${dbName}" WHERE rowid > ? ORDER BY rowid LIMIT ?`, [cursor, pageSize]);
                    if (page.length === 0) break;
                    cursor = Number(page[page.length - 1]._rowid);

                    const transformed = page.map((raw) => transformRow(raw, metas, dbName));
                    stat.scanned += transformed.length;

                    if (collectAll) {
                        collected.push(...transformed);
                    } else {
                        await insertBatches(target, targetTable, dbName, transformed, batchSize, apply, stat);
                    }

                    if (page.length < pageSize) break;
                }

                if (collectAll) {
                    const ordered = topoSortDepartments(collected);
                    await insertBatches(target, targetTable, dbName, ordered, batchSize, apply, stat);
                }

                console.log(`  ✓ ${dbName.padEnd(26)} scanned=${stat.scanned} ${apply ? "inserted" : "예정"}=${stat.inserted}`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                errors.push(`[${dbName}] ${msg}`);
                console.error(`  ✗ ${dbName.padEnd(26)} 실패: ${msg}`);
            }
        }
    } finally {
        if (apply && disableFk) {
            try {
                await target.execRaw("SET session_replication_role = DEFAULT");
            } catch {
                /* 원복 실패는 세션 종료로 자연 해소 */
            }
        }
        await source.close();
        await target.close();
    }

    // ── 결과 요약 ────────────────────────────────────────────────────────────────
    let totalScanned = 0;
    let totalInserted = 0;
    for (const s of stats.values()) {
        totalScanned += s.scanned;
        totalInserted += s.inserted;
    }
    console.log("\n── 결과 ──");
    console.log(`  테이블 ${stats.size}개, scanned=${totalScanned}, ${apply ? "inserted" : "삽입 예정"}=${totalInserted}`);
    if (errors.length > 0) {
        console.log("\n⚠ 실패 테이블(수동 확인 필요):");
        for (const e of errors) console.log(`   - ${e}`);
    }
    if (!apply) {
        console.log("\n✅ dry-run 완료. 실제 적용하려면 동일 env 로 `--apply` 를 붙여 재실행하세요.");
    } else {
        console.log("\n✅ 적용 완료. onConflictDoNothing 이므로 재실행해도 안전(멱등)합니다.");
        console.log("   이후 대상 PG 에서 각 테이블 count / 핵심 로그인·OIDC·SAML 스모크 테스트로 검증하세요.");
    }
    if (errors.length > 0) process.exit(2);
}

/** transformed 배열을 batchSize 단위로 pg insert(onConflictDoNothing). apply=false 면 카운트만. */
async function insertBatches(target: ScriptDb, targetTable: unknown, dbName: string, rows: Record<string, unknown>[], batchSize: number, apply: boolean, stat: TableStat): Promise<void> {
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        if (batch.length === 0) continue;
        stat.inserted += batch.length;
        if (!apply) continue;
        try {
            await target.db.insert(targetTable).values(batch).onConflictDoNothing();
        } catch (e) {
            const firstId = batch[0]?.id ?? batch[0]?.key ?? "(no id)";
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`INSERT 실패 (batch offset=${i}, 첫 행 id/key=${String(firstId)}): ${msg}`, { cause: e });
        }
    }
}

main().catch((err) => {
    console.error("✗ 오류:", err instanceof Error ? err.message : err);
    process.exit(1);
});
