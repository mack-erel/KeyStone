/**
 * 마스터 시크릿(IDP_SIGNING_KEY_SECRET) 무중단 회전용 재암호화 배치.
 *
 * previous(old) 시크릿으로 저장된 암호문을 current(new) 시크릿으로 재암호화한다.
 * Phase 9 무중단 회전 절차의 3단계에 해당한다(자세한 절차: docs/SECRET_ROTATION.md).
 *
 * 대상 3종:
 *   1. signing_keys 활성행(active=true AND rotated_at IS NULL) 의 private_jwk_encrypted
 *      — HKDF info "idp-signing-key-wrap-v1", AES-256-GCM (salt.iv.ct)
 *   2. credentials(type='totp') 의 secret
 *      — v1: "idp-totp-secret-wrap-v1", v2: "idp-totp-secret-wrap-v2:<userId>" + AAD
 *        (app 의 encrypt/decryptTotpSecret 를 그대로 재사용 — 형식 보존)
 *   3. identity_providers(kind='ldap') 의 config_json 내 bindPasswordEnc
 *      — HKDF info "idp-ldap-bind-password-v1", AES-256-GCM (salt.iv.ct)
 *
 * ── 사용법 ────────────────────────────────────────────────────────────────────
 *   IDP_SIGNING_KEY_SECRET_PREVIOUS='<old-secret>' \
 *   IDP_SIGNING_KEY_SECRET='<new-secret>' \
 *   DB_DIALECT=postgres DATABASE_URL='...' \
 *   bun scripts/reencrypt-secrets.ts            # 기본 dry-run (건수만 보고, 미변경)
 *
 *   ... bun scripts/reencrypt-secrets.ts --apply   # 실제 적용(DB 쓰기)
 *
 * ── 안전 특성 ──────────────────────────────────────────────────────────────────
 *   - 기본이 dry-run 이다. 실제 DB 쓰기는 반드시 `--apply` 를 명시해야 한다.
 *   - 멱등성: 이미 new 로 재암호화된 행(old 복호 실패 + new 복호 성공)은 "이미 완료"로
 *     간주하고 건너뛴다. 반복 실행해도 안전하다.
 *   - old/new 둘 다로 복호가 실패하는 행은 error 로 집계하고 계속 진행한다(중단 X).
 *   - 이 스크립트는 원격 DB 를 변경할 수 있다 — 프로젝트 규칙상 자동 실행 금지.
 *     운영자가 값 확인 후 직접 실행해야 한다.
 */
import "reflect-metadata";
import { and, eq, isNull } from "drizzle-orm";
import { openScriptDb } from "./lib/db";
import { decryptTotpSecret, encryptTotpSecret, isLegacyTotpCiphertext } from "../src/lib/server/auth/totp";

// ── env ────────────────────────────────────────────────────────────────────────

function readEnv(key: string): string | undefined {
    const v = process.env[key];
    return v && v.length > 0 ? v : undefined;
}

// ── AES-256-GCM + HKDF primitives (keys.ts 와 동일 규격: salt16.iv12.ct, SHA-256) ──
// keys.ts 는 $lib alias 를 import 하므로 bun 스크립트에서 직접 import 불가 →
// signing key wrap / generic secret 용 primitive 만 여기 인라인한다(포맷 완전 동일).

function b64uEncode(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

function b64uDecode(str: string): Uint8Array {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
}

async function deriveGcmKey(secret: string, salt: Uint8Array, info: string, usages: KeyUsage[]): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: enc.encode(info) }, keyMaterial, { name: "AES-GCM", length: 256 }, false, usages);
}

async function decryptGcmBlob(blob: string, secret: string, info: string): Promise<Uint8Array> {
    const parts = blob.split(".");
    if (parts.length !== 3) throw new Error("Invalid GCM blob format (expected salt.iv.ct)");
    const [saltB, ivB, ctB] = parts;
    const key = await deriveGcmKey(secret, b64uDecode(saltB), info, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64uDecode(ivB) as BufferSource }, key, b64uDecode(ctB) as BufferSource);
    return new Uint8Array(pt);
}

async function encryptGcmBytes(bytes: Uint8Array, secret: string, info: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveGcmKey(secret, salt, info, ["encrypt"]);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, bytes as BufferSource);
    return `${b64uEncode(salt)}.${b64uEncode(iv)}.${b64uEncode(new Uint8Array(ct))}`;
}

// ── 재암호화 결과 타입 ───────────────────────────────────────────────────────────

type ReencryptResult = { status: "reencrypted"; value: string } | { status: "already" } | { status: "error"; message: string };

/**
 * generic GCM blob(signing key / LDAP secret) 재암호화.
 * old 로 복호 성공 → new 로 재암호화. old 실패 & new 성공 → 이미 완료. 둘 다 실패 → error.
 */
async function reencryptGcmBlob(blob: string, oldSecret: string, newSecret: string, info: string): Promise<ReencryptResult> {
    let plaintext: Uint8Array;
    try {
        plaintext = await decryptGcmBlob(blob, oldSecret, info);
    } catch {
        try {
            await decryptGcmBlob(blob, newSecret, info);
            return { status: "already" };
        } catch {
            return { status: "error", message: "old/new 둘 다로 복호 실패" };
        }
    }
    const value = await encryptGcmBytes(plaintext, newSecret, info);
    return { status: "reencrypted", value };
}

/** TOTP secret 재암호화 (app 의 encrypt/decryptTotpSecret 재사용 — v1/v2 형식 보존). */
async function reencryptTotpSecret(blob: string, userId: string, oldSecret: string, newSecret: string): Promise<ReencryptResult> {
    let plain: string;
    try {
        plain = await decryptTotpSecret(blob, oldSecret, userId);
    } catch {
        try {
            await decryptTotpSecret(blob, newSecret, userId);
            return { status: "already" };
        } catch {
            return { status: "error", message: "old/new 둘 다로 복호 실패" };
        }
    }
    // 형식 보존: 원본이 v1(레거시)이면 v1 으로, v2 면 v2(userId 바인딩)로 재암호화.
    const value = isLegacyTotpCiphertext(blob) ? await encryptTotpSecret(plain, newSecret) : await encryptTotpSecret(plain, newSecret, userId);
    return { status: "reencrypted", value };
}

// ── 집계 카운터 ──────────────────────────────────────────────────────────────────

interface Counter {
    scanned: number;
    reencrypted: number;
    already: number;
    error: number;
    skipped: number; // 대상 필드 없음(예: LDAP bindPasswordEnc 미설정)
}

function newCounter(): Counter {
    return { scanned: 0, reencrypted: 0, already: 0, error: 0, skipped: 0 };
}

function reportCounter(label: string, c: Counter, apply: boolean): void {
    const verb = apply ? "재암호화" : "재암호화 예정";
    console.log(`  [${label}] scanned=${c.scanned} ${verb}=${c.reencrypted} already=${c.already} skipped=${c.skipped} error=${c.error}`);
}

// ── main ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args = new Set(process.argv.slice(2));
    const apply = args.has("--apply") || args.has("--no-dry-run");
    if (args.has("--dry-run") && apply) {
        console.error("✗ --dry-run 과 --apply 를 동시에 지정할 수 없습니다.");
        process.exit(1);
    }

    const oldSecret = readEnv("IDP_SIGNING_KEY_SECRET_PREVIOUS");
    const newSecret = readEnv("IDP_SIGNING_KEY_SECRET");

    if (!oldSecret) {
        console.error("✗ IDP_SIGNING_KEY_SECRET_PREVIOUS (old 시크릿) 가 필요합니다.");
        process.exit(1);
    }
    if (!newSecret) {
        console.error("✗ IDP_SIGNING_KEY_SECRET (new 시크릿) 가 필요합니다.");
        process.exit(1);
    }
    if (oldSecret === newSecret) {
        console.error("✗ old 와 new 시크릿이 동일합니다 — 회전할 것이 없습니다.");
        process.exit(1);
    }

    const h = await openScriptDb();
    const { db, schema } = h;
    const { signingKeys, credentials, identityProviders } = schema;

    console.log(`재암호화 배치 (dialect=${h.dialect}, mode=${apply ? "APPLY(DB 쓰기)" : "DRY-RUN(미변경)"})`);
    if (!apply) console.log("  ※ dry-run 입니다. 실제 적용하려면 --apply 를 붙이세요.");

    const signing = newCounter();
    const totp = newCounter();
    const ldap = newCounter();
    const errors: string[] = [];

    try {
        // ── 1. signing_keys 활성행 private_jwk_encrypted ─────────────────────────
        const signingRows = await db
            .select({ id: signingKeys.id, tenantId: signingKeys.tenantId, kid: signingKeys.kid, enc: signingKeys.privateJwkEncrypted })
            .from(signingKeys)
            .where(and(eq(signingKeys.active, true), isNull(signingKeys.rotatedAt)));

        for (const row of signingRows as Array<{ id: string; tenantId: string; kid: string; enc: string }>) {
            signing.scanned++;
            const res = await reencryptGcmBlob(row.enc, oldSecret, newSecret, "idp-signing-key-wrap-v1");
            if (res.status === "error") {
                signing.error++;
                errors.push(`signing_keys id=${row.id} kid=${row.kid}: ${res.message}`);
            } else if (res.status === "already") {
                signing.already++;
            } else {
                signing.reencrypted++;
                if (apply) {
                    await db.update(signingKeys).set({ privateJwkEncrypted: res.value }).where(eq(signingKeys.id, row.id));
                }
            }
        }

        // ── 2. credentials(type='totp') secret ───────────────────────────────────
        const totpRows = await db.select({ id: credentials.id, userId: credentials.userId, secret: credentials.secret }).from(credentials).where(eq(credentials.type, "totp"));

        for (const row of totpRows as Array<{ id: string; userId: string; secret: string | null }>) {
            totp.scanned++;
            if (!row.secret) {
                totp.skipped++;
                continue;
            }
            const res = await reencryptTotpSecret(row.secret, row.userId, oldSecret, newSecret);
            if (res.status === "error") {
                totp.error++;
                errors.push(`credentials(totp) id=${row.id} user=${row.userId}: ${res.message}`);
            } else if (res.status === "already") {
                totp.already++;
            } else {
                totp.reencrypted++;
                if (apply) {
                    await db.update(credentials).set({ secret: res.value }).where(eq(credentials.id, row.id));
                }
            }
        }

        // ── 3. identity_providers(kind='ldap') config_json.bindPasswordEnc ────────
        const ldapRows = await db
            .select({ id: identityProviders.id, tenantId: identityProviders.tenantId, configJson: identityProviders.configJson })
            .from(identityProviders)
            .where(eq(identityProviders.kind, "ldap"));

        for (const row of ldapRows as Array<{ id: string; tenantId: string; configJson: string | null }>) {
            ldap.scanned++;
            let cfg: Record<string, unknown>;
            try {
                cfg = JSON.parse(row.configJson ?? "{}") as Record<string, unknown>;
            } catch {
                ldap.error++;
                errors.push(`identity_providers(ldap) id=${row.id}: config_json 파싱 실패`);
                continue;
            }
            const enc = typeof cfg.bindPasswordEnc === "string" ? cfg.bindPasswordEnc : null;
            if (!enc) {
                ldap.skipped++; // 암호화된 bindPassword 가 없는 provider (평문/미설정)
                continue;
            }
            const res = await reencryptGcmBlob(enc, oldSecret, newSecret, "idp-ldap-bind-password-v1");
            if (res.status === "error") {
                ldap.error++;
                errors.push(`identity_providers(ldap) id=${row.id}: ${res.message}`);
            } else if (res.status === "already") {
                ldap.already++;
            } else {
                ldap.reencrypted++;
                if (apply) {
                    const migrated = { ...cfg, bindPasswordEnc: res.value };
                    await db
                        .update(identityProviders)
                        .set({ configJson: JSON.stringify(migrated), updatedAt: new Date() })
                        .where(eq(identityProviders.id, row.id));
                }
            }
        }

        // ── 결과 요약 ─────────────────────────────────────────────────────────────
        console.log("\n── 결과 ──");
        reportCounter("signing_keys", signing, apply);
        reportCounter("credentials(totp)", totp, apply);
        reportCounter("identity_providers(ldap)", ldap, apply);

        const totalError = signing.error + totp.error + ldap.error;
        if (errors.length > 0) {
            console.log("\n⚠ 복호 실패 행 (수동 확인 필요):");
            for (const e of errors) console.log(`   - ${e}`);
        }

        if (!apply) {
            console.log("\n✅ dry-run 완료. 실제 적용하려면 동일 env 로 `--apply` 를 붙여 재실행하세요.");
        } else {
            console.log(`\n✅ 적용 완료. 재암호화된 행: signing=${signing.reencrypted} totp=${totp.reencrypted} ldap=${ldap.reencrypted}.`);
            console.log("   이후 스모크 테스트(OIDC token, SAML SSO, TOTP 로그인, LDAP 로그인) 를 수행하고,");
            console.log("   확인되면 IDP_SIGNING_KEY_SECRET_PREVIOUS 를 제거해 회전을 마무리하세요.");
        }

        if (totalError > 0) process.exit(2);
    } finally {
        await h.close();
    }
}

main().catch((err) => {
    console.error("✗ 오류:", err instanceof Error ? err.message : err);
    process.exit(1);
});
