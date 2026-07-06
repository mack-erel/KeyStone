import { describe, it, expect } from "vitest";
import { is } from "drizzle-orm";
import { SQLiteTable, getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { PgTable, getTableConfig as getPgTableConfig } from "drizzle-orm/pg-core";
import { MySqlTable, getTableConfig as getMysqlTableConfig } from "drizzle-orm/mysql-core";
import * as sqliteSchema from "../../src/lib/server/db/schema.sqlite";
import * as pgSchema from "../../src/lib/server/db/schema.pg";
import * as mysqlSchema from "../../src/lib/server/db/schema.mysql";

/**
 * E1: 3개 방언 스키마(schema.sqlite/pg/mysql)를 drizzle introspection 으로 정규화해
 * 다음 축의 parity 를 강제한다. 수작업 동기화 중 한 방언에만 생기는 drift 를 CI 에서 잡는다.
 *
 *   1. 테이블 집합
 *   2. 테이블별 컬럼 집합
 *   3. 컬럼별 nullable(notNull) 여부
 *   4. 컬럼별 타입 "계열"(type family) — 방언 간 정당한 물리 타입 차이는 아래 매핑 테이블로
 *      정규화해 비교하고, 정규화 불가능한 진짜 drift 만 실패시킨다.
 *   5. 인덱스·unique 제약 — 인덱스 이름 + unique 여부 + 대상 컬럼 집합. 방언별 정당한
 *      차이는 INDEX_PARITY_EXCEPTIONS 로 명시 문서화하고, 목록에 없는 신규 drift 만 실패.
 */

// ── 타입 계열(type family) 매핑 테이블 ────────────────────────────────────────────
//
// 방언 간 정당한 SQL 타입 차이를 하나의 "계열" 로 정규화한다. 키는 drizzle 의 columnType
// (방언별 컬럼 구현 클래스명), 값은 방언 독립 계열 문자열이다.
//
// 예) 타임스탬프 컬럼의 물리 타입은 방언마다 다르지만 모두 "date" 계열이다:
//       sqlite integer(mode:timestamp_ms) / pg timestamp(3, tz) / mysql datetime(fsp:3)
//     불리언도 sqlite integer(mode:boolean) / pg boolean / mysql boolean(tinyint) → "boolean".
//     문자열은 sqlite/pg text 와 mysql varchar|text → "string"(mysql 은 인덱싱 위해 길이 필요).
//
// 이 표에 없는 columnType 이 등장하면(=미분류) 아래 컬럼 parity 검사에서 명시적으로 실패해
// 새 타입을 의도적으로 계열 분류하도록 강제한다(조용한 오분류 방지).
const COLUMN_TYPE_FAMILY: Record<string, string> = {
    // string 계열
    SQLiteText: "string",
    PgText: "string",
    MySqlVarChar: "string",
    MySqlText: "string",
    // number 계열
    SQLiteInteger: "number",
    PgInteger: "number",
    MySqlInt: "number",
    // boolean 계열
    SQLiteBoolean: "boolean",
    PgBoolean: "boolean",
    MySqlBoolean: "boolean",
    // date/timestamp 계열
    SQLiteTimestamp: "date",
    PgTimestamp: "date",
    MySqlDateTime: "date",
};

// ── 인덱스 parity 예외 목록 ───────────────────────────────────────────────────────
//
// 방언별로 정당하게 존재/부재가 갈리는 인덱스를 명시 문서화한다. 여기 등재된 (테이블,
// 인덱스명) 조합은 `missingIn` 에 나열된 방언에서 누락돼 있어도 drift 로 보지 않는다.
// 목록에 없는 신규 누락/추가/컬럼불일치만 실패한다.
interface IndexParityException {
    table: string;
    index: string;
    /** 이 인덱스가 정당하게 누락된 방언들. */
    missingIn: Dialect[];
    reason: string;
}
const INDEX_PARITY_EXCEPTIONS: IndexParityException[] = [
    {
        table: "signing_keys",
        index: "signing_keys_tenant_one_active_uidx",
        missingIn: ["mysql"],
        // MySQL 은 partial unique index (WHERE active) 를 지원하지 않는다. sqlite/pg 는 부분
        // 유니크 인덱스로 "tenant 당 active signing key 1개" 불변식을 DB 레벨에서 강제하고,
        // mysql 은 애플리케이션 레벨 트랜잭션으로 동일 불변식을 보장한다(schema.mysql.ts 주석).
        reason: "MySQL 은 partial unique index 미지원 → 앱 레벨 트랜잭션으로 대체",
    },
];

// ── introspection 정규화 ──────────────────────────────────────────────────────────

type Dialect = "sqlite" | "pg" | "mysql";

interface ColumnInfo {
    notNull: boolean;
    /** 정규화된 타입 계열. 미분류 columnType 이면 `unmapped:<columnType>`. */
    family: string;
}
interface IndexInfo {
    unique: boolean;
    /** 대상 컬럼명 정렬 목록(JSON 직렬화용). 표현식 인덱스 항목은 "<expr>". */
    columns: string[];
}
interface TableInfo {
    columns: Map<string, ColumnInfo>;
    indexes: Map<string, IndexInfo>;
}

function familyOf(columnType: string): string {
    return COLUMN_TYPE_FAMILY[columnType] ?? `unmapped:${columnType}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function normalizeTable(cfg: { columns: any[]; indexes: any[] }): TableInfo {
    const columns = new Map<string, ColumnInfo>();
    for (const c of cfg.columns) {
        columns.set(c.name, { notNull: Boolean(c.notNull), family: familyOf(c.columnType) });
    }
    const indexes = new Map<string, IndexInfo>();
    for (const idx of cfg.indexes) {
        const conf = idx.config;
        const cols = conf.columns.map((col: any) => col?.name ?? "<expr>").sort();
        indexes.set(conf.name, { unique: Boolean(conf.unique), columns: cols });
    }
    return { columns, indexes };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function buildTableMap(schema: Record<string, unknown>, dialect: Dialect): Map<string, TableInfo> {
    const out = new Map<string, TableInfo>();
    for (const value of Object.values(schema)) {
        if (dialect === "sqlite" && is(value, SQLiteTable)) {
            const cfg = getSqliteTableConfig(value);
            out.set(cfg.name, normalizeTable(cfg));
        } else if (dialect === "pg" && is(value, PgTable)) {
            const cfg = getPgTableConfig(value);
            out.set(cfg.name, normalizeTable(cfg));
        } else if (dialect === "mysql" && is(value, MySqlTable)) {
            const cfg = getMysqlTableConfig(value);
            out.set(cfg.name, normalizeTable(cfg));
        }
    }
    return out;
}

const dialects: { name: Dialect; tables: Map<string, TableInfo> }[] = [
    { name: "sqlite", tables: buildTableMap(sqliteSchema as Record<string, unknown>, "sqlite") },
    { name: "pg", tables: buildTableMap(pgSchema as Record<string, unknown>, "pg") },
    { name: "mysql", tables: buildTableMap(mysqlSchema as Record<string, unknown>, "mysql") },
];

// sqlite 를 기준 방언으로 삼는다(테이블/컬럼 집합 parity 는 아래에서 별도 강제).
const sqlite = dialects[0].tables;
const others = dialects.slice(1);

function isAllowedIndexOmission(table: string, index: string, dialect: Dialect): boolean {
    return INDEX_PARITY_EXCEPTIONS.some((e) => e.table === table && e.index === index && e.missingIn.includes(dialect));
}

describe("schema dialect parity (E1)", () => {
    it("세 방언의 테이블 집합이 동일", () => {
        const sqliteTables = [...sqlite.keys()].sort();
        for (const { name, tables } of others) {
            expect([...tables.keys()].sort(), `[${name}] 테이블 집합`).toEqual(sqliteTables);
        }
    });

    it("각 테이블의 컬럼 집합이 세 방언에서 동일", () => {
        const mismatches: string[] = [];
        for (const [table, info] of sqlite) {
            const sqliteCols = [...info.columns.keys()].sort();
            for (const { name, tables } of others) {
                const cols = [...(tables.get(table)?.columns.keys() ?? [])].sort();
                if (JSON.stringify(cols) !== JSON.stringify(sqliteCols)) {
                    mismatches.push(`[${name}] ${table}: sqlite=${sqliteCols.join(",")} vs ${name}=${cols.join(",")}`);
                }
            }
        }
        expect(mismatches).toEqual([]);
    });

    it("각 컬럼의 nullable(notNull) 여부가 세 방언에서 동일", () => {
        const mismatches: string[] = [];
        for (const [table, info] of sqlite) {
            for (const [col, sc] of info.columns) {
                for (const { name, tables } of others) {
                    const oc = tables.get(table)?.columns.get(col);
                    if (oc && oc.notNull !== sc.notNull) {
                        mismatches.push(`[${name}] ${table}.${col}: sqlite.notNull=${sc.notNull} vs ${name}.notNull=${oc.notNull}`);
                    }
                }
            }
        }
        expect(mismatches).toEqual([]);
    });

    it("모든 컬럼의 타입이 매핑 테이블에 분류돼 있다(미분류 columnType 없음)", () => {
        const unmapped: string[] = [];
        for (const { name, tables } of dialects) {
            for (const [table, info] of tables) {
                for (const [col, ci] of info.columns) {
                    if (ci.family.startsWith("unmapped:")) {
                        unmapped.push(`[${name}] ${table}.${col}: ${ci.family}`);
                    }
                }
            }
        }
        expect(unmapped).toEqual([]);
    });

    it("각 컬럼의 타입 계열(type family)이 세 방언에서 동일", () => {
        const mismatches: string[] = [];
        for (const [table, info] of sqlite) {
            for (const [col, sc] of info.columns) {
                for (const { name, tables } of others) {
                    const oc = tables.get(table)?.columns.get(col);
                    if (oc && oc.family !== sc.family) {
                        mismatches.push(`[${name}] ${table}.${col}: sqlite=${sc.family} vs ${name}=${oc.family}`);
                    }
                }
            }
        }
        expect(mismatches).toEqual([]);
    });

    it("인덱스·unique 제약이 세 방언에서 동일(예외 목록 제외)", () => {
        const mismatches: string[] = [];
        for (const table of sqlite.keys()) {
            // 세 방언 중 이 테이블에 존재하는 모든 인덱스 이름의 합집합을 대상으로 비교.
            const indexNames = new Set<string>();
            for (const { tables } of dialects) {
                for (const idxName of tables.get(table)?.indexes.keys() ?? []) indexNames.add(idxName);
            }

            for (const idxName of indexNames) {
                // 각 방언의 인덱스 시그니처(없으면 undefined) 수집.
                const perDialect = dialects.map(({ name, tables }) => ({
                    dialect: name,
                    idx: tables.get(table)?.indexes.get(idxName),
                }));

                // (a) 누락 검사 — 예외 목록에 없는 누락은 drift.
                for (const { dialect, idx } of perDialect) {
                    if (!idx && !isAllowedIndexOmission(table, idxName, dialect)) {
                        mismatches.push(`[${dialect}] ${table}.${idxName}: 인덱스 누락(예외 목록에 없음)`);
                    }
                }

                // (b) 존재하는 방언들끼리 시그니처(unique + 컬럼 집합) 일치 검사.
                const present = perDialect.filter((d) => d.idx);
                if (present.length >= 2) {
                    const ref = present[0].idx!;
                    const refSig = JSON.stringify({ unique: ref.unique, columns: ref.columns });
                    for (const { dialect, idx } of present.slice(1)) {
                        const sig = JSON.stringify({ unique: idx!.unique, columns: idx!.columns });
                        if (sig !== refSig) {
                            mismatches.push(`[${dialect}] ${table}.${idxName}: ${present[0].dialect}=${refSig} vs ${dialect}=${sig}`);
                        }
                    }
                }
            }
        }
        expect(mismatches).toEqual([]);
    });
});
