/**
 * 패스워드 해싱 유틸리티
 *
 * 신규 해시: scrypt (node:crypto 네이티브 — Workers nodejs_compat / Node / Bun 공통)
 * 레거시 해시: argon2id (@hicaru/argon2-pure.js), PBKDF2-SHA256 — 검증 후 scrypt 로 자동 업그레이드
 *
 * argon2id → scrypt 전환 이유: @hicaru/argon2-pure.js 는 순수 JS 라 verify 1회에
 * ~4.4초의 CPU 를 태운다 (Workers 요청 지연의 주범). Workers 는 런타임 WASM
 * 바이트 컴파일을 금지해 WASM argon2 도입에는 빌드 배관이 필요한 반면,
 * node:crypto scrypt 는 2025-04 부터 Workers 에서 네이티브(BoringSSL) 지원되어
 * 동일한 메모리 하드 강도를 ~100ms 에 처리한다 (OWASP 승인 KDF).
 *
 * 파라미터: N=2^15, r=8, p=3 (32 MiB) — OWASP scrypt 최소 권고 조합 중 하나.
 * Workers isolate 메모리 한도(128 MB) 안에서 동시 요청을 견디는 상한으로 선택.
 */

import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { verifyEncoded } from "@hicaru/argon2-pure.js";

// ── scrypt ────────────────────────────────────────────────────────────────────

const SCRYPT_N = 32768; // 2^15
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_LENGTH = 16;
// BoringSSL 기본 maxmem(32 MiB)이 128*N*r = 32 MiB 와 경계라 여유를 둔다.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

// 저장된 해시의 파라미터 파싱 시 허용 상한 — 손상/조작된 레코드가 요청당
// 과도한 메모리/CPU 를 유발하지 않도록 방어.
const SCRYPT_MAX_N = 131072; // 2^17
const SCRYPT_MAX_R = 32;
const SCRYPT_MAX_P = 16;

function deriveScrypt(password: string, salt: Uint8Array, keyLength: number, N: number, r: number, p: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        scryptCallback(password, salt, keyLength, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, derived) => {
            if (err) reject(err);
            else resolve(new Uint8Array(derived.buffer, derived.byteOffset, derived.byteLength));
        });
    });
}

export async function hashPassword(password: string): Promise<string> {
    const salt = new Uint8Array(randomBytes(SCRYPT_SALT_LENGTH));
    const derived = await deriveScrypt(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_N, SCRYPT_R, SCRYPT_P);
    return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

async function verifyScrypt(password: string, record: string): Promise<{ valid: boolean; paramsCurrent: boolean }> {
    const invalid = { valid: false, paramsCurrent: true };
    const parts = record.split("$");
    if (parts.length !== 4) return invalid;
    const [, params, saltB64, hashB64] = parts;

    const parsed: Record<string, number> = {};
    for (const pair of params.split(",")) {
        const [key, value] = pair.split("=");
        parsed[key] = Number(value);
    }
    const { N, r, p } = parsed;
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return invalid;
    if (N < 2 || (N & (N - 1)) !== 0 || N > SCRYPT_MAX_N) return invalid;
    if (r < 1 || r > SCRYPT_MAX_R || p < 1 || p > SCRYPT_MAX_P) return invalid;

    try {
        const salt = base64ToBytes(saltB64);
        const storedHash = base64ToBytes(hashB64);
        const derived = await deriveScrypt(password, salt, storedHash.length, N, r, p);
        return {
            valid: timingSafeEqual(derived, storedHash),
            paramsCurrent: N === SCRYPT_N && r === SCRYPT_R && p === SCRYPT_P,
        };
    } catch {
        return invalid;
    }
}

// ── 공통 유틸 ─────────────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string): Uint8Array {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
        difference |= left[index] ^ right[index];
    }
    return difference === 0;
}

// ── 검증 진입점 ───────────────────────────────────────────────────────────────

export async function verifyPassword(
    password: string,
    record: string,
): Promise<{
    valid: boolean;
    rehash?: string;
}> {
    // scrypt (현행 형식) — 파라미터가 이후 상향된 경우 현행 파라미터로 자동 업그레이드
    if (record.startsWith("scrypt$")) {
        const { valid, paramsCurrent } = await verifyScrypt(password, record);
        if (!valid) return { valid: false };
        if (paramsCurrent) return { valid: true };
        return { valid: true, rehash: await hashPassword(password) };
    }

    // argon2id 레거시 (@hicaru 순수 JS — verify 1회 ~4.4초) — 검증 후 scrypt 로 업그레이드
    if (record.startsWith("$argon2")) {
        const pwd = new TextEncoder().encode(password);
        const valid = verifyEncoded(record, pwd);
        if (!valid) return { valid: false };
        return { valid: true, rehash: await hashPassword(password) };
    }

    // PBKDF2 레거시 — 검증 후 scrypt 로 업그레이드
    if (record.startsWith("pbkdf2$")) {
        const legacyResult = await verifyPbkdf2(password, record);
        if (!legacyResult) return { valid: false };
        return { valid: true, rehash: await hashPassword(password) };
    }

    return { valid: false };
}

// ── PBKDF2 레거시 검증 (신규 해싱에는 사용하지 않음) ──────────────────────────

const PBKDF2_ITERATIONS = 100_000;

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
