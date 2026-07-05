import { describe, it, expect } from "vitest";
import { getTableColumns, getTableName, is, Table } from "drizzle-orm";
import * as sqliteSchema from "../../src/lib/server/db/schema.sqlite";
import * as pgSchema from "../../src/lib/server/db/schema.pg";
import * as mysqlSchema from "../../src/lib/server/db/schema.mysql";

/**
 * E1: 3개 방언 스키마(schema.sqlite/pg/mysql)의 테이블·컬럼 집합이 동일한지 강제한다.
 * 수작업 동기화 중 한 방언에만 컬럼을 추가/삭제/개명하는 drift 를 CI 에서 잡는다.
 * (인덱스 parity 는 방언별 API 차이로 이 테스트 범위 밖 — 별도 수동 검토 필요.)
 */
function tableColumnMap(schema: Record<string, unknown>): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const value of Object.values(schema)) {
        if (is(value, Table)) {
            const cols = Object.values(getTableColumns(value))
                .map((c) => (c as { name: string }).name)
                .sort();
            out.set(getTableName(value), cols);
        }
    }
    return out;
}

const sqlite = tableColumnMap(sqliteSchema as Record<string, unknown>);
const pg = tableColumnMap(pgSchema as Record<string, unknown>);
const mysql = tableColumnMap(mysqlSchema as Record<string, unknown>);

describe("schema dialect parity (E1)", () => {
    it("세 방언의 테이블 집합이 동일", () => {
        const sqliteTables = [...sqlite.keys()].sort();
        const pgTables = [...pg.keys()].sort();
        const mysqlTables = [...mysql.keys()].sort();
        expect(pgTables).toEqual(sqliteTables);
        expect(mysqlTables).toEqual(sqliteTables);
    });

    it("각 테이블의 컬럼 집합이 세 방언에서 동일", () => {
        const mismatches: string[] = [];
        for (const [table, cols] of sqlite) {
            const pgCols = pg.get(table);
            const mysqlCols = mysql.get(table);
            if (pgCols && JSON.stringify(pgCols) !== JSON.stringify(cols)) {
                mismatches.push(`[pg] ${table}: sqlite=${cols.join(",")} vs pg=${pgCols.join(",")}`);
            }
            if (mysqlCols && JSON.stringify(mysqlCols) !== JSON.stringify(cols)) {
                mismatches.push(`[mysql] ${table}: sqlite=${cols.join(",")} vs mysql=${mysqlCols.join(",")}`);
            }
        }
        expect(mismatches).toEqual([]);
    });
});
