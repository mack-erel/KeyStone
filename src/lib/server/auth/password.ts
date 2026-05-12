/**
 * 패스워드 해싱 유틸리티
 *
 * 신규 해시: argon2id (@hicaru/argon2-pure.js — 순수 JS, Workers 호환)
 * 레거시 해시: PBKDF2-SHA256 (검증 후 argon2id로 자동 업그레이드)
 *
 * ctrls H-AUTH-4: OWASP profile 5 (m=7168 / t=5 / p=1) 로 상향.
 * 기존 m=4096 / t=3 는 OWASP 최소 권고치 미달이라 DB 덤프 시 크래킹 비용이
 * 부족했다. 순수 JS 구현 + Workers CPU 한도(paid 30s) 안에서 동작.
 * 추후 WASM 기반 구현(@rabbit-company/argon2id) 또는 native binding 도입
 * 시 더 높은 프로파일(owasp4: m=9216 / t=4, owasp3: m=12288 / t=3)로 상향
 * 권장.
 */

import { hashEncoded, verifyEncoded, Config, Variant, Version } from "@hicaru/argon2-pure.js";

// OWASP profile 5 — 순수 JS 구현으로 Workers 런타임 안에서 안정 동작 가능한 상한.
const ARGON2_CONFIG = new Config(
    new Uint8Array(), // ad
    32, // hashLength
    1, // lanes (parallelism)
    7168, // memCost (7 MB) — OWASP minimum
    new Uint8Array(), // secret
    5, // timeCost — OWASP minimum
    Variant.Argon2id,
    Version.Version13,
);

// ── argon2id ──────────────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
    const pwd = new TextEncoder().encode(password);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return hashEncoded(pwd, salt, ARGON2_CONFIG);
}

export async function verifyPassword(
    password: string,
    record: string,
): Promise<{
    valid: boolean;
    rehash?: string;
}> {
    const pwd = new TextEncoder().encode(password);

    // argon2id PHC 형식 ($argon2id$...)
    if (record.startsWith("$argon2")) {
        const valid = verifyEncoded(record, pwd);
        return { valid };
    }

    // PBKDF2 레거시 형식 — 검증 후 argon2id로 업그레이드
    if (record.startsWith("pbkdf2$")) {
        const legacyResult = await verifyPbkdf2(password, record);
        if (!legacyResult) return { valid: false };
        return { valid: true, rehash: await hashPassword(password) };
    }

    return { valid: false };
}

// ── PBKDF2 레거시 검증 (신규 해싱에는 사용하지 않음) ──────────────────────────

const PBKDF2_ITERATIONS = 100_000;

function base64ToBytes(value: string): Uint8Array {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
        difference |= left[index] ^ right[index];
    }
    return difference === 0;
}

async function verifyPbkdf2(password: string, record: string): Promise<boolean> {
    const parts = record.split("$");
    if (parts.length !== 4) return false;
    const [, params, saltB64, hashB64] = parts;
    const [digest, iterationsStr] = params?.split(":") ?? [];
    const iterations = Number(iterationsStr);
    // ctrls L-3 (H-AUTH-4 묶음): 기존 조건은 && 라서 사실상 모든 입력이 통과됐다.
    // digest 알고리즘 명시 일치 + iterations 최소값 강제로 정정.
    if (digest !== "sha256" || !Number.isFinite(iterations) || iterations < PBKDF2_ITERATIONS) return false;

    const salt = base64ToBytes(saltB64);
    const storedHash = base64ToBytes(hashB64);
    const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt.buffer as ArrayBuffer, iterations: iterations || PBKDF2_ITERATIONS }, keyMaterial, 256);
    return timingSafeEqual(new Uint8Array(bits), storedHash);
}
