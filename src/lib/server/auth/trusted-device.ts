/**
 * 신뢰 기기("이 기기에서 다시 인증하지 않기") 관리.
 *
 * 로그인 시 비밀번호는 항상 검증하되, 14일 이내에 MFA 를 통과한 기기라면 TOTP 단계를
 * 건너뛴다. 토큰은 session.ts 와 동일한 모델이다 — 랜덤 32바이트를 base64url 로 인코딩해
 * 쿠키로 내려주고, DB 에는 SHA-256 해시만 저장한다(원본 미저장).
 *
 * mfa.ts 의 HMAC 서명 토큰 방식을 쓰지 않는 이유: HMAC 토큰은 서버가 상태를 갖지 않아
 * 개별 폐기가 불가능하다. 신뢰 기기는 "기기 분실 시 즉시 무효화" 가 필수 요구사항이므로
 * DB 대조 방식을 쓴다(비밀번호 변경·TOTP 해제·세션 관리 화면에서 강제 폐기).
 */

import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Cookies } from "@sveltejs/kit";
import type { DB } from "$lib/server/db";
import { trustedDevices } from "$lib/server/db/schema";

export const TRUSTED_DEVICE_COOKIE = "idp_trusted_device";
export const TRUSTED_DEVICE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14일

function bytesToBase64Url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

async function hashTrustedDeviceToken(token: string): Promise<string> {
    const data = new TextEncoder().encode(token);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return bytesToBase64Url(new Uint8Array(hash));
}

function cookieOptions(url: URL, expiresAt: Date) {
    return {
        path: "/",
        httpOnly: true,
        sameSite: "lax" as const,
        secure: url.protocol === "https:",
        expires: expiresAt,
    };
}

/**
 * 신뢰 기기를 등록하고 쿠키에 담을 토큰 원본을 반환한다.
 * MFA 검증을 통과한 직후에만 호출해야 한다.
 */
export async function createTrustedDevice(
    db: DB,
    params: {
        tenantId: string;
        userId: string;
        ip?: string | null;
        userAgent?: string | null;
        /** true 면 등록 시점 ip 와 다른 요청에서는 신뢰를 적용하지 않는다(사용자 옵트인). */
        ipBound?: boolean;
    },
): Promise<{ token: string; expiresAt: Date }> {
    const now = Date.now();
    const expiresAt = new Date(now + TRUSTED_DEVICE_TTL_MS);
    const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const tokenHash = await hashTrustedDeviceToken(token);

    await db.insert(trustedDevices).values({
        id: crypto.randomUUID(),
        tenantId: params.tenantId,
        userId: params.userId,
        tokenHash,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        ipBound: params.ipBound ?? false,
        expiresAt,
        lastUsedAt: new Date(now),
    });

    return { token, expiresAt };
}

/**
 * 쿠키 토큰이 이 사용자의 유효한 신뢰 기기인지 검증한다.
 *
 * 통과 조건: 해시 일치 + userId/tenantId 일치 + revokedAt IS NULL + 미만료
 *            + (ipBound 인 경우) 등록 ip 와 현재 ip 일치.
 * 통과 시 lastUsedAt 을 갱신한다.
 */
export async function verifyTrustedDevice(db: DB, token: string, params: { userId: string; tenantId: string; ip?: string | null }): Promise<boolean> {
    if (!token) return false;

    const now = new Date();
    const tokenHash = await hashTrustedDeviceToken(token);

    const [row] = await db
        .select({ id: trustedDevices.id, ip: trustedDevices.ip, ipBound: trustedDevices.ipBound })
        .from(trustedDevices)
        .where(
            and(
                eq(trustedDevices.tokenHash, tokenHash),
                eq(trustedDevices.userId, params.userId),
                eq(trustedDevices.tenantId, params.tenantId),
                isNull(trustedDevices.revokedAt),
                gt(trustedDevices.expiresAt, now),
            ),
        )
        .limit(1);

    if (!row) return false;

    // IP 바인딩은 옵트인. 등록 시 ip 를 못 남긴 경우(row.ip === null)엔 대조할 기준이 없으므로
    // 신뢰를 적용하지 않는다(느슨하게 통과시키면 옵트인의 의미가 사라진다).
    if (row.ipBound && row.ip !== (params.ip ?? null)) return false;

    await db.update(trustedDevices).set({ lastUsedAt: now }).where(eq(trustedDevices.id, row.id));
    return true;
}

export interface TrustedDeviceInfo {
    id: string;
    ip: string | null;
    userAgent: string | null;
    ipBound: boolean;
    lastUsedAt: Date;
    createdAt: Date;
    expiresAt: Date;
}

/**
 * 사용자의 활성(revokedAt IS NULL·미만료) 신뢰 기기 목록을 최근 사용 순으로 반환한다.
 * 셀프서비스 세션 관리 화면에서 사용한다.
 */
export async function listTrustedDevices(db: DB, userId: string): Promise<TrustedDeviceInfo[]> {
    const now = new Date();
    return db
        .select({
            id: trustedDevices.id,
            ip: trustedDevices.ip,
            userAgent: trustedDevices.userAgent,
            ipBound: trustedDevices.ipBound,
            lastUsedAt: trustedDevices.lastUsedAt,
            createdAt: trustedDevices.createdAt,
            expiresAt: trustedDevices.expiresAt,
        })
        .from(trustedDevices)
        .where(and(eq(trustedDevices.userId, userId), isNull(trustedDevices.revokedAt), gt(trustedDevices.expiresAt, now)))
        .orderBy(desc(trustedDevices.lastUsedAt));
}

/**
 * `id` + `userId` 가 **동시에 일치**하는 활성 신뢰 기기만 폐기한다.
 *
 * IDOR 방지: userId 조건이 select·update 양쪽에 걸려 있어 다른 사용자의 id 를 넘겨도
 * 어떤 행도 폐기되지 않는다. 이미 폐기된 기기는 건드리지 않는다(멱등).
 *
 * 반환값: 실제로 한 행을 폐기했으면 `true`, 대상이 없거나(타 사용자/미존재/이미 폐기) `false`.
 */
export async function revokeTrustedDeviceById(db: DB, id: string, userId: string, revokedAt = new Date()): Promise<boolean> {
    // 방언 독립적으로 "영향 행 존재" 를 판정하기 위해 소유·활성 가드를 건 select 로 먼저 확인한다.
    const [target] = await db
        .select({ id: trustedDevices.id })
        .from(trustedDevices)
        .where(and(eq(trustedDevices.id, id), eq(trustedDevices.userId, userId), isNull(trustedDevices.revokedAt)))
        .limit(1);
    if (!target) return false;

    await db
        .update(trustedDevices)
        .set({ revokedAt })
        .where(and(eq(trustedDevices.id, id), eq(trustedDevices.userId, userId), isNull(trustedDevices.revokedAt)));
    return true;
}

/**
 * 사용자의 모든 신뢰 기기를 폐기한다.
 * 비밀번호 변경·TOTP 해제 등 인증 요소가 바뀌는 시점에 호출한다.
 */
export async function revokeAllTrustedDevices(db: DB, userId: string, revokedAt = new Date()) {
    await db
        .update(trustedDevices)
        .set({ revokedAt })
        .where(and(eq(trustedDevices.userId, userId), isNull(trustedDevices.revokedAt)));
}

export function setTrustedDeviceCookie(cookies: Cookies, url: URL, token: string, expiresAt: Date) {
    cookies.set(TRUSTED_DEVICE_COOKIE, token, cookieOptions(url, expiresAt));
}

export function clearTrustedDeviceCookie(cookies: Cookies, url: URL) {
    cookies.delete(TRUSTED_DEVICE_COOKIE, cookieOptions(url, new Date(0)));
}
