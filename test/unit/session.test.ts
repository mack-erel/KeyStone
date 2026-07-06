import { describe, it, expect } from "vitest";
import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { DB } from "$lib/server/db";
import { createSessionRecord, getSessionContext, touchSession, revokeSession, revokeAllUserSessions, revokeOtherSessions } from "$lib/server/auth/session";
import { SESSION_TTL_MS } from "$lib/server/auth/constants";

// ── 순수 로직 검증용 목(mock) ──────────────────────────────────────────────
// crud-factory.test.ts 패턴을 따른다: 실제 쿼리는 실행하지 않고 insert/update/select
// 체인에 전달된 값·where 조건만 캡처한다. where 는 drizzle SQL 객체이므로,
// SQLiteSyncDialect 로 파라미터화된 SQL 문자열로 렌더링해 컬럼·연산자·바인딩을 검증한다.
const dialect = new SQLiteSyncDialect();
function render(where: SQL): { sql: string; params: unknown[] } {
    const q = dialect.sqlToQuery(where);
    return { sql: q.sql, params: q.params };
}

interface UpdateCapture {
    set: Record<string, unknown>;
    where: SQL;
}
interface SelectCapture {
    on?: SQL;
    where?: SQL;
}

function makeDb(selectResult: unknown[] = []) {
    const inserts: Record<string, unknown>[] = [];
    const updates: UpdateCapture[] = [];
    const selects: SelectCapture[] = [];
    const db = {
        insert: () => ({
            values: async (v: Record<string, unknown>) => {
                inserts.push(v);
            },
        }),
        update: () => ({
            set: (set: Record<string, unknown>) => ({
                where: async (where: SQL) => {
                    updates.push({ set, where });
                },
            }),
        }),
        select: () => ({
            from: () => ({
                innerJoin: (_table: unknown, on: SQL) => ({
                    where: (where: SQL) => ({
                        limit: async () => {
                            selects.push({ on, where });
                            return selectResult;
                        },
                    }),
                }),
            }),
        }),
    } as unknown as DB;
    return { db, inserts, updates, selects };
}

// 모듈 내부 hashSessionToken 과 동일한 SHA-256 → base64url 산식(검증용 독립 재구현).
function bytesToBase64Url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}
async function sha256Base64Url(token: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return bytesToBase64Url(new Uint8Array(hash));
}

const BASE64URL_32BYTES = /^[A-Za-z0-9_-]{43}$/;

describe("createSessionRecord", () => {
    it("세션 토큰은 SHA-256 해시로만 저장하고 원문 토큰은 DB 에 남기지 않는다", async () => {
        const { db, inserts } = makeDb();
        const before = Date.now();
        const { sessionToken, sessionId, expiresAt } = await createSessionRecord(db, {
            tenantId: "t1",
            userId: "u1",
            amr: ["pwd", "totp"],
            acr: "acr-mfa",
            ip: "1.2.3.4",
            userAgent: "ua",
        });
        const after = Date.now();

        expect(inserts.length).toBe(1);
        const row = inserts[0];

        // 저장된 idpSessionId 는 반환된 원문 토큰의 SHA-256(base64url) 해시여야 한다.
        const expectedHash = await sha256Base64Url(sessionToken);
        expect(row.idpSessionId).toBe(expectedHash);
        // 원문 토큰 자체는 어떤 컬럼에도 저장되지 않는다.
        expect(row.idpSessionId).not.toBe(sessionToken);
        expect(Object.values(row)).not.toContain(sessionToken);
        // 해시 형식(32바이트 base64url = 43자)·원문 토큰 형식 모두 확인.
        expect(row.idpSessionId).toMatch(BASE64URL_32BYTES);
        expect(sessionToken).toMatch(BASE64URL_32BYTES);

        // 나머지 필드 전파 확인.
        expect(row.id).toBe(sessionId);
        expect(row.tenantId).toBe("t1");
        expect(row.userId).toBe("u1");
        expect(row.amr).toBe("pwd totp"); // 배열 → 공백 결합
        expect(row.acr).toBe("acr-mfa");
        expect(row.ip).toBe("1.2.3.4");
        expect(row.userAgent).toBe("ua");
        expect(row.lastSeenAt).toBeInstanceOf(Date);

        // 만료 시각 = 생성 시각 + SESSION_TTL_MS (경계 여유 포함).
        const exp = (expiresAt as Date).getTime();
        expect(exp).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
        expect(exp).toBeLessThanOrEqual(after + SESSION_TTL_MS);
    });

    it("amr/acr 미지정 시 null 로 저장한다", async () => {
        const { db, inserts } = makeDb();
        await createSessionRecord(db, { tenantId: "t1", userId: "u1" });
        expect(inserts[0].amr).toBeNull();
        expect(inserts[0].acr).toBeNull();
        expect(inserts[0].ip).toBeNull();
        expect(inserts[0].userAgent).toBeNull();
    });
});

describe("getSessionContext", () => {
    it("유효 세션 라운드트립 — 원문 토큰이 아닌 SHA-256 해시로 조회한다", async () => {
        const rowResult = { session: { id: "s1" }, user: { id: "u1" } };
        const { db, selects } = makeDb([rowResult]);
        const token = "raw-session-token";

        const result = await getSessionContext(db, token);
        expect(result).toBe(rowResult);

        // 조회 where 의 첫 바인딩은 원문 토큰이 아니라 그 SHA-256 해시여야 한다.
        expect(selects.length).toBe(1);
        const { sql, params } = render(selects[0].where!);
        const expectedHash = await sha256Base64Url(token);
        expect(sql).toContain('"sessions"."idp_session_id" = ?');
        expect(params[0]).toBe(expectedHash);
        expect(params).not.toContain(token);
    });

    it("만료·폐기·비활성 세션을 DB 레벨 where 가드로 배제한다", async () => {
        const { db, selects } = makeDb([]);
        await getSessionContext(db, "tok");
        const { sql, params } = render(selects[0].where!);

        // 만료 세션 거부: expires_at > now
        expect(sql).toContain('"sessions"."expires_at" > ?');
        // revoke 세션 거부: revoked_at IS NULL
        expect(sql).toContain('"sessions"."revoked_at" is null');
        // 비활성 사용자 거부: users.status = 'active'
        expect(sql).toContain('"users"."status" = ?');
        expect(params).toContain("active");
    });

    it("매칭 세션이 없으면 null 을 반환한다", async () => {
        const { db } = makeDb([]);
        expect(await getSessionContext(db, "tok")).toBeNull();
    });
});

describe("touchSession", () => {
    it("lastSeenAt 만 갱신하고 세션 id 로 대상 지정한다", async () => {
        const { db, updates } = makeDb();
        const ts = new Date("2026-01-01T00:00:00Z");
        await touchSession(db, "s1", ts);
        expect(updates.length).toBe(1);
        expect(updates[0].set).toEqual({ lastSeenAt: ts });
        const { sql, params } = render(updates[0].where);
        expect(sql).toContain('"sessions"."id" = ?');
        expect(params).toEqual(["s1"]);
    });
});

describe("revokeSession", () => {
    it("revokedAt 를 설정하고, 아직 폐기되지 않은 대상 세션만 갱신한다", async () => {
        const { db, updates } = makeDb();
        const now = new Date("2026-02-02T00:00:00Z");
        await revokeSession(db, "idp-session-id-value", now);
        expect(updates.length).toBe(1);
        expect(updates[0].set).toEqual({ revokedAt: now });

        const { sql, params } = render(updates[0].where);
        expect(sql).toContain('"sessions"."idp_session_id" = ?');
        // 이미 폐기된 행은 재갱신하지 않는다(멱등).
        expect(sql).toContain('"sessions"."revoked_at" is null');
        expect(params[0]).toBe("idp-session-id-value");
    });
});

describe("revokeAllUserSessions", () => {
    it("사용자의 모든 미폐기 세션을 revoke 한다(세션 제외 없음)", async () => {
        const { db, updates } = makeDb();
        const now = new Date("2026-03-03T00:00:00Z");
        await revokeAllUserSessions(db, "u1", now);
        expect(updates[0].set).toEqual({ revokedAt: now });

        const { sql, params } = render(updates[0].where);
        expect(sql).toContain('"sessions"."user_id" = ?');
        expect(sql).toContain('"sessions"."revoked_at" is null');
        // 특정 세션을 남기는 조건(id <>)이 없어야 전부 폐기된다.
        expect(sql).not.toContain("<>");
        expect(params).toEqual(["u1"]);
    });
});

describe("revokeOtherSessions", () => {
    it("keepSessionId 를 제외한 사용자의 미폐기 세션만 revoke 한다", async () => {
        const { db, updates } = makeDb();
        const now = new Date("2026-04-04T00:00:00Z");
        await revokeOtherSessions(db, "u1", "keep-1", now);
        expect(updates[0].set).toEqual({ revokedAt: now });

        const { sql, params } = render(updates[0].where);
        expect(sql).toContain('"sessions"."user_id" = ?');
        // 유지할 세션(keepSessionId)은 제외.
        expect(sql).toContain('"sessions"."id" <> ?');
        // 이미 폐기된 세션은 건드리지 않는다.
        expect(sql).toContain('"sessions"."revoked_at" is null');
        expect(params).toEqual(["u1", "keep-1"]);
    });
});
