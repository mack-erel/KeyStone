import { dev } from "$app/environment";
import { and, eq } from "drizzle-orm";
import type { DB } from "$lib/server/db";
import { signingKeys, type Tenant, tenants } from "$lib/server/db/schema";
import { DEFAULT_TENANT_SLUG } from "./constants";
import { getRuntimeConfig, type RuntimeConfig } from "./runtime";
import { generateRsaSigningKey, generateSelfSignedCert, tryWithSecrets, unwrapPrivateKey, wrapPrivateKey } from "$lib/server/crypto/keys";

function isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Error && /unique constraint failed/i.test(error.message);
}

export async function ensureDefaultTenant(db: DB, platform: App.Platform | undefined): Promise<Tenant> {
    const [existingTenant] = await db.select().from(tenants).where(eq(tenants.slug, DEFAULT_TENANT_SLUG)).limit(1);

    if (existingTenant) {
        return existingTenant;
    }

    try {
        await db.insert(tenants).values({
            id: crypto.randomUUID(),
            slug: DEFAULT_TENANT_SLUG,
            name: getRuntimeConfig(platform).defaultTenantName,
            status: "active",
        });
    } catch (error) {
        if (!isUniqueConstraintError(error)) {
            throw error;
        }
    }

    const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, DEFAULT_TENANT_SLUG)).limit(1);

    if (!tenant) {
        throw new Error("기본 tenant 를 초기화하지 못했습니다.");
    }

    return tenant;
}

export async function ensureSigningKey(db: DB, tenant: Tenant, signingKeySecrets: string[], issuerUrl?: string): Promise<void> {
    // SAML KeyDescriptor 용 CN
    let cn = "idp";
    if (issuerUrl) {
        try {
            cn = new URL(issuerUrl).hostname;
        } catch {
            cn = issuerUrl;
        }
    }

    const [existing] = await db
        .select()
        .from(signingKeys)
        .where(and(eq(signingKeys.tenantId, tenant.id), eq(signingKeys.active, true)))
        .limit(1);

    // 키가 있지만 cert_pem 이 없는 경우 (M1 → M2 업그레이드): backfill
    if (existing) {
        if (!existing.certPem) {
            // 무보호 예외 지점: 무중단 회전 창에서 previous 로 래핑된 키도 복호되도록 fallback.
            const privateKey = await tryWithSecrets(signingKeySecrets, (s) => unwrapPrivateKey(existing.privateJwkEncrypted, s));
            const publicJwk = JSON.parse(existing.publicJwk) as JsonWebKey;
            const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]);
            const certPem = await generateSelfSignedCert(publicKey, privateKey, cn);
            await db.update(signingKeys).set({ certPem }).where(eq(signingKeys.id, existing.id));
        }
        return;
    }

    const { kid, publicKey, privateKey, publicJwk } = await generateRsaSigningKey();
    // 발급/암호화는 항상 current(=secrets[0])만 사용한다. previous fallback 금지.
    const privateJwkEncrypted = await wrapPrivateKey(privateKey, signingKeySecrets[0]);
    const certPem = await generateSelfSignedCert(publicKey, privateKey, cn);

    await db.insert(signingKeys).values({
        id: crypto.randomUUID(),
        tenantId: tenant.id,
        kid,
        use: "sig",
        alg: "RS256",
        publicJwk: JSON.stringify(publicJwk),
        privateJwkEncrypted,
        certPem,
        active: true,
    });
}

/**
 * S5 fail-fast: 프로덕션 필수 환경변수 검증.
 *
 * `IDP_ISSUER_URL` / `IDP_SIGNING_KEY_SECRET` 는 프로덕션에서 반드시 설정되어야
 * 한다. 미설정이면 토큰 발급 시점(ensureSigningKey 조용한 스킵, resolveIssuerUrl
 * Host fallback)이 아니라 요청 초기(ensureAuthBaseline) 에 명확한 오류로 실패시켜
 * 오구성을 즉시 드러낸다.
 *
 * dev 에서는 로컬 DX(변수 없이 구동) 보존을 위해 검증을 건너뛴다.
 *
 * 검증 결과는 성공 시 1회만 계산되도록 캐시한다(설정은 isolate 수명 내 불변).
 * 실패 시 캐시하지 않으므로 요청마다 재검증되어 fail-closed 를 유지한다.
 */
let requiredConfigValidated = false;
function assertRequiredConfig(config: RuntimeConfig): void {
    if (dev || requiredConfigValidated) return;

    const missing: string[] = [];
    if (!config.issuerUrl) missing.push("IDP_ISSUER_URL");
    if (!config.signingKeySecret) missing.push("IDP_SIGNING_KEY_SECRET");

    if (missing.length > 0) {
        throw new Error(`프로덕션 필수 환경변수가 설정되지 않았습니다: ${missing.join(", ")}. 배포 환경 변수/시크릿을 확인해 주세요.`);
    }

    requiredConfigValidated = true;
}

const BASELINE_TTL_MS = 5 * 60 * 1000; // 5분

interface BaselineCache {
    tenant: Tenant;
    expiresAt: number;
}

// Workers isolate 레벨 캐시 — 같은 isolate 내 요청들이 공유하여 D1 쿼리를 절감한다.
const g = globalThis as typeof globalThis & { __idpBaselineCache?: BaselineCache };

export async function ensureAuthBaseline(db: DB, platform: App.Platform | undefined) {
    const now = Date.now();

    if (g.__idpBaselineCache && g.__idpBaselineCache.expiresAt > now) {
        return g.__idpBaselineCache.tenant;
    }

    const config = getRuntimeConfig(platform);
    // 프로덕션 필수값 검증 — DB 작업 전에 요청 초기에 fail-fast.
    assertRequiredConfig(config);
    const tenant = await ensureDefaultTenant(db, platform);
    if (config.signingKeySecrets.length > 0) {
        await ensureSigningKey(db, tenant, config.signingKeySecrets, config.issuerUrl);
    }

    g.__idpBaselineCache = { tenant, expiresAt: now + BASELINE_TTL_MS };
    return tenant;
}
