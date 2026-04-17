/**
 * 패스워드 해싱 유틸리티
 *
 * Cloudflare Workers 제약:
 *  - WebAssembly.compile() 에 인라인 바이트를 전달하는 것이 금지됨
 *  - hash-wasm 은 이 방식으로 WASM 을 로드하므로 Workers 에서 동작하지 않음
 *  - WebCrypto PBKDF2 는 최대 100,000 회까지만 허용
 *
 * 현재 구현: PBKDF2-SHA256, 100,000 회 (Workers 상한)
 */

const PASSWORD_ALGORITHM = "pbkdf2";
const PASSWORD_DIGEST = "sha256";
const PASSWORD_ITERATIONS = 100_000;
const PASSWORD_SALT_LENGTH = 16;

function bytesToBase64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string): Uint8Array {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) {
        return false;
    }

    let difference = 0;

    for (let index = 0; index < left.length; index += 1) {
        difference |= left[index] ^ right[index];
    }

    return difference === 0;
}

async function derivePasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
    const normalizedSalt = new Uint8Array(salt);
    const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: normalizedSalt.buffer, iterations }, keyMaterial, 256);

    return new Uint8Array(bits);
}

function formatHashRecord(salt: Uint8Array, hash: Uint8Array, iterations = PASSWORD_ITERATIONS): string {
    return `${PASSWORD_ALGORITHM}$${PASSWORD_DIGEST}:${iterations}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

function parseHashRecord(record: string) {
    const [algorithm, params, saltB64, hashB64] = record.split("$");
    const [digest, iterationsString] = params?.split(":") ?? [];
    const iterations = Number(iterationsString);

    if (algorithm !== PASSWORD_ALGORITHM || digest !== PASSWORD_DIGEST || !Number.isFinite(iterations) || !saltB64 || !hashB64) {
        return null;
    }

    return {
        iterations,
        salt: base64ToBytes(saltB64),
        hash: base64ToBytes(hashB64),
    };
}

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_LENGTH));
    const hash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS);

    return formatHashRecord(salt, hash);
}

export async function verifyPassword(
    password: string,
    record: string,
): Promise<{
    valid: boolean;
    rehash?: string;
}> {
    const parsed = parseHashRecord(record);

    if (!parsed) {
        return { valid: false };
    }

    const candidateHash = await derivePasswordHash(password, parsed.salt, parsed.iterations);
    const valid = timingSafeEqual(candidateHash, parsed.hash);

    if (!valid) {
        return { valid: false };
    }

    // 이전에 낮은 iterations 로 해싱된 경우 재해싱
    if (parsed.iterations !== PASSWORD_ITERATIONS) {
        return {
            valid: true,
            rehash: await hashPassword(password),
        };
    }

    return { valid: true };
}
