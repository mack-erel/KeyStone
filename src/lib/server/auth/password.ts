/**
 * 패스워드 해싱 유틸리티
 *
 * 신규 해시: argon2id (@hicaru/argon2-pure.js — 순수 JS, Workers 호환)
 * 레거시 해시: PBKDF2-SHA256 (검증 후 argon2id로 자동 업그레이드)
 *
 * Cloudflare Workers 제약상 memCost를 보수적으로 설정함.
 * OWASP 최소 권고(owasp5: m=7168, t=5)보다 낮으나 Workers CPU 한도 내 동작을 우선.
 * 추후 WASM 기반 구현(@rabbit-company/argon2id)으로 전환 시 파라미터 상향 권장.
 */

import { hashEncoded, verifyEncoded, Config, Variant, Version } from "@hicaru/argon2-pure.js";

// Workers CPU 한도(~50ms) 내에서 동작 가능한 보수적 파라미터
const ARGON2_CONFIG = new Config(
    new Uint8Array(), // ad
    32, // hashLength
    1, // lanes (parallelism)
    4096, // memCost (4 MB)
    new Uint8Array(), // secret
    3, // timeCost
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
    if (digest !== "sha256:100000" && !Number.isFinite(iterations)) return false;

    const salt = base64ToBytes(saltB64);
    const storedHash = base64ToBytes(hashB64);
    const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt.buffer as ArrayBuffer, iterations: iterations || PBKDF2_ITERATIONS }, keyMaterial, 256);
    return timingSafeEqual(new Uint8Array(bits), storedHash);
}

// ── 관리자 전용: 순수 PBKDF2 파싱 (하위 호환 포맷 유지) ─────────────────────

function parseHashRecord(record: string) {
    const [algorithm, params, saltB64, hashB64] = record.split("$");
    const [digest, iterationsString] = params?.split(":") ?? [];
    const iterations = Number(iterationsString);
    if (algorithm !== "pbkdf2" || digest !== "sha256" || !Number.isFinite(iterations) || !saltB64 || !hashB64) return null;
    return { iterations, salt: base64ToBytes(saltB64), hash: base64ToBytes(hashB64) };
}

export async function verifyPasswordLegacy(password: string, record: string): Promise<boolean> {
    if (record.startsWith("$argon2")) {
        return verifyEncoded(record, new TextEncoder().encode(password));
    }
    const parsed = parseHashRecord(record);
    if (!parsed) return false;
    const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: parsed.salt.buffer as ArrayBuffer, iterations: parsed.iterations }, keyMaterial, 256);
    return timingSafeEqual(new Uint8Array(bits), parsed.hash);
}
