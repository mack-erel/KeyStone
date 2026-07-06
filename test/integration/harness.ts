/**
 * Phase 11 통합 테스트 하네스.
 *
 * 목적: mock 이 아닌 **실제 DB**(libSQL `:memory:`) 위에 **실제 drizzle 스키마 마이그레이션**을
 * 적용하고, 실제 서버 모듈(auth/oidc/route 핸들러)을 직접 구동해 풀플로우를 검증한다.
 *
 * 핵심 구성:
 *  1. openMemoryDb(): libSQL `:memory:` 클라이언트 + drizzle 인스턴스를 만들고
 *     `drizzle/sqlite/*.sql` 을 journal 순서대로 적용한다(scripts/lib/db.ts 의 executeMultiple 패턴).
 *  2. makeEvent(): 라우트 핸들러(+server.ts / +page.server.ts)가 기대하는 RequestEvent/locals 를
 *     최소 구성으로 조립한다(db·tenant·session·user·runtimeConfig·platform·cookies·locale).
 *  3. 시드 유틸: 테넌트/서명키/유저/OIDC 클라이언트/서비스 할당/세션.
 *
 * 격리: 케이스마다 새 인메모리 DB(= 새 tenantId)를 만든다. 서명키/JWKS/baseline 은
 * globalThis 캐시를 쓰므로 tenantId 가 달라 케이스 간 오염이 없다(추가로 서명키 캐시는
 * invalidate 유틸을 노출한다).
 */

import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import type { RequestEvent } from "@sveltejs/kit";
import type { DB } from "$lib/server/db";
import { credentials, oidcClients, sessions, tenants, userServiceAssignments, users, type Session, type Tenant, type User } from "$lib/server/db/schema";
import { ensureDefaultTenant, ensureSigningKey } from "$lib/server/auth/bootstrap";
import { getRuntimeConfig, type RuntimeConfig } from "$lib/server/auth/runtime";
import { hashPassword } from "$lib/server/auth/password";
import { hashClientSecret } from "$lib/server/oidc/client";
import { createSessionRecord } from "$lib/server/auth/session";
import { b64uEncode } from "$lib/server/crypto/keys";

// ── 테스트용 마스터 시크릿 / issuer ────────────────────────────────────────────────
// 실 서명·암호화 경로가 이 값을 사용한다. platform.env 로 주입해 getRuntimeConfig 가 읽는다.
export const TEST_SIGNING_SECRET = "test-signing-secret-current-abcdefghijklmnopqrstuvwxyz-0123456789";
export const TEST_SIGNING_SECRET_PREVIOUS = "test-signing-secret-previous-ABCDEFGHIJKLMNOPQRSTUVWXYZ-9876543210";
export const TEST_ISSUER_URL = "https://idp.test.example";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationsDir = join(projectRoot, "drizzle", "sqlite");

interface JournalEntry {
    idx: number;
    tag: string;
}

/** _journal.json 을 읽어 마이그레이션 태그를 idx 오름차순으로 반환한다. */
function migrationTags(): string[] {
    const journalPath = join(migrationsDir, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as { entries: JournalEntry[] };
    return [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag);
}

export interface MemoryDb {
    db: DB;
    client: Client;
    /** platform.env 로 넘길 환경. getRuntimeConfig 가 읽는다. */
    env: Record<string, string>;
    close(): void;
}

/**
 * libSQL `:memory:` DB 를 만들고 실제 마이그레이션(SQL)을 순서대로 적용한다.
 * executeMultiple 은 `;` 로 구분된 여러 문장을 한 번에 실행한다(마이그레이션 파일 통째 적용).
 */
export async function openMemoryDb(envOverrides: Record<string, string> = {}): Promise<MemoryDb> {
    const client = createClient({ url: ":memory:" });
    for (const tag of migrationTags()) {
        const sqlText = readFileSync(join(migrationsDir, `${tag}.sql`), "utf-8");
        await client.executeMultiple(sqlText);
    }
    // 앱 런타임과 동일하게 FK 제약을 활성화한다(마이그레이션 DDL 적용 이후).
    await client.execute("PRAGMA foreign_keys = ON");

    const db = drizzle(client, { schema: { tenants, users, credentials, sessions, oidcClients, userServiceAssignments } }) as unknown as DB;

    const env: Record<string, string> = {
        IDP_ISSUER_URL: TEST_ISSUER_URL,
        IDP_SIGNING_KEY_SECRET: TEST_SIGNING_SECRET,
        IDP_DEFAULT_TENANT_NAME: "Test Tenant",
        ...envOverrides,
    };

    return {
        db,
        client,
        env,
        close() {
            client.close();
        },
    };
}

// ── 테스트용 platform / RequestEvent ────────────────────────────────────────────────

/** getRuntimeConfig 가 읽는 최소 platform. ctx 는 없음(=Node 경로, waitUntil 미노출). */
export function makePlatform(env: Record<string, string>): App.Platform {
    return { env } as unknown as App.Platform;
}

/** Map 기반 최소 Cookies 스텁. 라우트가 set/get/delete 하는 세션·MFA 쿠키를 담는다. */
export function makeCookies(initial: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initial));
    return {
        get: (name: string) => store.get(name),
        getAll: () => Array.from(store.entries()).map(([name, value]) => ({ name, value })),
        set: (name: string, value: string) => {
            store.set(name, value);
        },
        delete: (name: string) => {
            store.delete(name);
        },
        serialize: () => "",
        _store: store,
    };
}

export interface MakeEventOptions {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    /** application/x-www-form-urlencoded 폼 본문(POST 액션/토큰 엔드포인트용). */
    form?: Record<string, string>;
    locals: {
        db: DB;
        tenant: Tenant | null;
        user?: User | null;
        session?: Session | null;
        locale?: string;
        env: Record<string, string>;
    };
    cookies?: ReturnType<typeof makeCookies>;
}

/**
 * 실제 라우트 핸들러가 소비하는 RequestEvent 를 조립한다.
 * 핸들러가 실제로 접근하는 필드(request/url/locals/platform/cookies/getClientAddress)만 채운다.
 *
 * 반환 타입은 `RequestEvent<never, never>` 로 둔다. 각 라우트 핸들러는 `./$types` 로
 * RouteId/RouteParams 가 좁혀진 `RequestEvent<RouteParams, "/oidc/token">` 등을 파라미터로
 * 받는데, `never` 는 모든 리터럴에 대입 가능하므로 어떤 라우트 핸들러에도 그대로 넘길 수 있다.
 */
export function makeEvent(opts: MakeEventOptions): RequestEvent<never, never> {
    const method = opts.method ?? "GET";
    const url = new URL(opts.url ?? "https://idp.test.example/");
    const headers = new Headers(opts.headers ?? {});

    let body: BodyInit | undefined;
    if (opts.form) {
        const params = new URLSearchParams(opts.form);
        body = params;
        if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded");
    }
    const request = new Request(url.toString(), { method, headers, body });

    const platform = makePlatform(opts.locals.env);
    const runtimeConfig: RuntimeConfig = getRuntimeConfig(platform);
    const cookies = opts.cookies ?? makeCookies();

    const locals: App.Locals = {
        db: opts.locals.db,
        tenant: opts.locals.tenant,
        user: opts.locals.user ?? null,
        session: opts.locals.session ?? null,
        runtimeConfig,
        runtimeError: null,
        locale: (opts.locals.locale ?? "ko") as App.Locals["locale"],
    };

    return {
        request,
        url,
        locals,
        platform,
        cookies,
        params: {},
        route: { id: null },
        getClientAddress: () => "127.0.0.1",
        setHeaders: () => {},
        isDataRequest: false,
        isSubRequest: false,
        fetch: globalThis.fetch,
    } as unknown as RequestEvent<never, never>;
}

// ── 시드 유틸 ────────────────────────────────────────────────────────────────────

/** 기본 테넌트 + 활성 서명키(실 RSA 키·cert)를 생성한다. */
export async function seedTenantAndSigningKey(mem: MemoryDb): Promise<Tenant> {
    const platform = makePlatform(mem.env);
    const config = getRuntimeConfig(platform);
    const tenant = await ensureDefaultTenant(mem.db, platform);
    await ensureSigningKey(mem.db, tenant, config.signingKeySecrets, config.issuerUrl);
    return tenant;
}

export interface SeedUserOptions {
    tenantId: string;
    email: string;
    username?: string | null;
    password?: string;
    role?: "admin" | "user";
    status?: "active" | "disabled" | "locked" | "deletion_pending";
    emailVerifiedAt?: Date | null;
    displayName?: string;
    deletionScheduledAt?: Date | null;
}

/** 유저를 생성하고, password 가 주어지면 password credential 도 함께 생성한다. */
export async function seedUser(db: DB, opts: SeedUserOptions): Promise<User> {
    const id = crypto.randomUUID();
    await db.insert(users).values({
        id,
        tenantId: opts.tenantId,
        email: opts.email.toLowerCase(),
        username: opts.username === undefined ? opts.email.split("@")[0] : opts.username,
        displayName: opts.displayName ?? "Test User",
        role: opts.role ?? "user",
        status: opts.status ?? "active",
        emailVerifiedAt: opts.emailVerifiedAt === undefined ? new Date() : opts.emailVerifiedAt,
        deletionScheduledAt: opts.deletionScheduledAt ?? null,
    });

    if (opts.password) {
        await db.insert(credentials).values({
            id: crypto.randomUUID(),
            userId: id,
            type: "password",
            secret: await hashPassword(opts.password),
            label: "비밀번호",
        });
    }

    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return row!;
}

export interface SeedOidcClientOptions {
    tenantId: string;
    clientId: string;
    secret?: string;
    redirectUris: string[];
    scopes?: string;
    grantTypes?: string;
    tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
    requirePkce?: boolean;
}

export async function seedOidcClient(db: DB, opts: SeedOidcClientOptions): Promise<typeof oidcClients.$inferSelect> {
    const id = crypto.randomUUID();
    await db.insert(oidcClients).values({
        id,
        tenantId: opts.tenantId,
        clientId: opts.clientId,
        clientSecretHash: opts.secret ? await hashClientSecret(opts.secret) : null,
        name: opts.clientId,
        redirectUris: JSON.stringify(opts.redirectUris),
        scopes: opts.scopes ?? "openid profile email offline_access",
        grantTypes: opts.grantTypes ?? "authorization_code,refresh_token",
        tokenEndpointAuthMethod: opts.tokenEndpointAuthMethod ?? "client_secret_basic",
        requirePkce: opts.requirePkce ?? true,
        enabled: true,
    });
    const [row] = await db.select().from(oidcClients).where(eq(oidcClients.id, id)).limit(1);
    return row!;
}

/** 유저에게 서비스(OIDC/SAML) 접근 권한을 부여한다(기본 deny 를 통과시키기 위함). */
export async function seedServiceAssignment(db: DB, args: { tenantId: string; userId: string; serviceType: "oidc" | "saml"; serviceRefId: string }): Promise<void> {
    await db.insert(userServiceAssignments).values({
        id: crypto.randomUUID(),
        tenantId: args.tenantId,
        userId: args.userId,
        serviceType: args.serviceType,
        serviceRefId: args.serviceRefId,
    });
}

/** 실제 createSessionRecord 로 세션을 만들고 raw 토큰 + Session row 를 돌려준다. */
export async function seedSession(db: DB, args: { tenantId: string; userId: string }): Promise<{ session: Session; sessionToken: string }> {
    const { sessionToken, sessionId } = await createSessionRecord(db, {
        tenantId: args.tenantId,
        userId: args.userId,
        amr: ["pwd"],
        acr: "urn:mace:incommon:iap:silver",
    });
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    return { session: session!, sessionToken };
}

// ── 헬퍼: PKCE / redirect 파싱 ─────────────────────────────────────────────────────

/** S256 code_challenge 를 계산한다(실 라우트/pkce.ts 와 동일 알고리즘). */
export async function pkceChallengeS256(verifier: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return b64uEncode(hash);
}

/** throw 된 SvelteKit redirect 를 잡아 Location 을 반환한다. redirect 가 아니면 재throw. */
export async function catchRedirect(fn: () => unknown): Promise<{ status: number; location: string }> {
    try {
        await fn();
    } catch (e) {
        const r = e as { status?: number; location?: string };
        if (typeof r.status === "number" && typeof r.location === "string") {
            return { status: r.status, location: r.location };
        }
        throw e;
    }
    throw new Error("redirect 가 발생하지 않았습니다.");
}
