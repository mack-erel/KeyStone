/**
 * SAML 2.0 SSO 엔드포인트.
 *
 * 지원 흐름:
 *   1. SP-initiated / HTTP-Redirect 바인딩
 *      GET /saml/sso?SAMLRequest=<base64(deflate(XML))>&RelayState=...&SigAlg=...&Signature=...
 *   2. SP-initiated / HTTP-POST 바인딩
 *      POST /saml/sso  (body: SAMLRequest=<base64(XML)>, RelayState=...)
 *   3. IdP-initiated (unsolicited)
 *      GET /saml/sso?sp=<entityId>[&RelayState=...]  (SAMLRequest 없음)
 *
 * 공통 처리: AuthnRequest 파싱 → 로그인 확인 → 서비스 권한 게이트 → SAML Response 생성 →
 *            ACS 로 HTTP-POST auto-submit 폼 전송.
 */

import { error, redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { and, eq, gt } from "drizzle-orm";
import type { DB } from "$lib/server/db";
import type { Session, Tenant, User } from "$lib/server/db/schema";
import { requireDbContext } from "$lib/server/auth/guards";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit";
import { checkRateLimit } from "$lib/server/ratelimit";
import { getActiveSigningKey } from "$lib/server/crypto/keys";
import { acrSatisfies } from "$lib/server/auth/constants";
import { samlAuthnRequestIds } from "$lib/server/db/schema";
import type { ParsedAuthnRequest } from "$lib/server/saml/parse-authn-request";
import { parseAuthnRequest, parseAuthnRequestPost, verifySamlRedirectSignature, encodeRedirectBindingSamlRequest } from "$lib/server/saml/parse-authn-request";
import { verifyEnvelopedXmlSignature } from "$lib/server/saml/verify-xml-signature";
import { buildSignedSamlErrorResponse, buildSignedSamlResponse } from "$lib/server/saml/response";
import { findSp, recordSamlSession, type SamlSpRecord } from "$lib/server/saml/sp";
import { getUserMembership } from "$lib/server/org/membership";
import { getActiveAssignment, parseAssignmentAttributes } from "$lib/server/access/service-permissions";

const SAML_AUTHN_REQUEST_TTL_MS = 10 * 60 * 1000; // 10분

function htmlEscape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** ACS 로 SAMLResponse 를 실어 보내는 HTTP-POST auto-submit 폼 응답. */
function renderAutoSubmitForm(acsUrl: string, samlResponseB64: string, relayState: string | null): Response {
    const relayStateInput = relayState ? `<input type="hidden" name="RelayState" value="${htmlEscape(relayState)}">` : "";
    const html =
        `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>SSO 리다이렉트 중...</title></head>` +
        `<body onload="document.getElementById('samlForm').submit()">` +
        `<form id="samlForm" method="POST" action="${htmlEscape(acsUrl)}">` +
        `<input type="hidden" name="SAMLResponse" value="${samlResponseB64}">${relayStateInput}` +
        `</form></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** 서명된 SAML 오류 Response 를 만들어 ACS 로 POST 하는 폼 응답. */
async function buildAndRenderSamlError(params: {
    inResponseTo: string | null;
    acsUrl: string;
    issuerUrl: string;
    subStatusCode: string;
    certPem: string;
    privateKey: CryptoKey;
    relayState: string | null;
}): Promise<Response> {
    const errorB64 = await buildSignedSamlErrorResponse({
        inResponseTo: params.inResponseTo ?? "",
        acsUrl: params.acsUrl,
        issuerUrl: params.issuerUrl,
        subStatusCode: params.subStatusCode,
        certPem: params.certPem,
        privateKey: params.privateKey,
    });
    return renderAutoSubmitForm(params.acsUrl, errorB64, params.relayState);
}

interface GateAndIssueParams {
    db: DB;
    tenant: Tenant;
    issuerUrl: string;
    sp: SamlSpRecord;
    user: User;
    session: Session;
    acsUrl: string;
    /** SP-initiated 면 AuthnRequest ID, IdP-initiated(unsolicited) 면 null. */
    inResponseTo: string | null;
    relayState: string | null;
    certPem: string;
    privateKey: CryptoKey;
}

/**
 * 공통 후반부: 서비스 권한 게이트 → (SP-initiated 한정) replay ID 소비 → attribute 매핑 →
 * NameID 결정 → SAML 세션 기록 → Response 서명/암호화 → ACS POST 폼 렌더.
 *
 * SP-initiated / IdP-initiated 세 흐름이 모두 재사용한다. inResponseTo 가 있으면 그 값을
 * Response 의 InResponseTo 로 채우고 replay ID 를 소비하며, null 이면 unsolicited 로 처리한다.
 *
 * replay ID 소비는 "Assertion 발급 직전"에 수행한다 — 로그인/forceAuthn 재진입으로 동일
 * AuthnRequest 가 되돌아오는 정상 흐름을 깨지 않으면서도, 하나의 AuthnRequest 로 두 번
 * Assertion 이 발급되는 것을 막는다.
 */
async function gateAndIssueSamlAssertion(event: Parameters<RequestHandler>[0], p: GateAndIssueParams): Promise<Response> {
    const { db, tenant, sp, user, session } = p;

    // 서비스 권한 게이트 (기본 deny). 매핑 없으면 SSO 거부.
    const spAssignment = await getActiveAssignment(db, {
        tenantId: tenant.id,
        userId: user.id,
        serviceType: "saml",
        serviceRefId: sp.id,
    });
    if (!spAssignment) {
        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: user.id,
            actorId: user.id,
            spOrClientId: sp.entityId,
            kind: "saml_sso",
            outcome: "failure",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { error: "access_denied", reason: "no_service_assignment" },
        });
        throw error(403, "이 SP에 대한 권한이 없습니다.");
    }

    // Replay 가드 (SP-initiated 한정). Assertion 발급 직전에 동일 AuthnRequest ID 의
    // 재사용 여부를 확인 후 INSERT. unsolicited(inResponseTo=null)는 대응 요청이 없어 생략.
    if (p.inResponseTo) {
        const now = new Date();
        const [seen] = await db
            .select({ requestId: samlAuthnRequestIds.requestId })
            .from(samlAuthnRequestIds)
            .where(and(eq(samlAuthnRequestIds.tenantId, tenant.id), eq(samlAuthnRequestIds.requestId, p.inResponseTo), gt(samlAuthnRequestIds.expiresAt, now)))
            .limit(1);
        if (seen) {
            throw error(400, "AuthnRequest ID 가 이미 사용되었습니다 (replay)");
        }
        try {
            await db.insert(samlAuthnRequestIds).values({
                tenantId: tenant.id,
                requestId: p.inResponseTo,
                spEntityId: sp.entityId,
                expiresAt: new Date(Date.now() + SAML_AUTHN_REQUEST_TTL_MS),
            });
        } catch {
            // unique constraint 충돌 → replay 와 동일하게 거부
            throw error(400, "AuthnRequest ID 가 이미 사용되었습니다 (replay)");
        }
    }

    // Attribute 매핑 (attributeMappingJson 또는 기본값)
    type AttributeMap = Record<string, string>;
    let attrMapping: AttributeMap = {};
    if (sp.attributeMappingJson) {
        try {
            attrMapping = JSON.parse(sp.attributeMappingJson) as AttributeMap;
        } catch {
            /* 기본 매핑 사용 */
        }
    }

    // SP 별 허용 속성 목록. NULL → 기본 최소 집합. 명시된 경우만 조직정보 등이 포함된다.
    const DEFAULT_ALLOWED = ["email", "username", "displayName"] as const;
    let allowedSet: Set<string>;
    if (sp.allowedAttributes) {
        try {
            const parsed = JSON.parse(sp.allowedAttributes) as unknown;
            allowedSet = new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : DEFAULT_ALLOWED);
        } catch {
            allowedSet = new Set(DEFAULT_ALLOWED);
        }
    } else {
        allowedSet = new Set(DEFAULT_ALLOWED);
    }

    const attributes: Record<string, string> = {};
    const setAttr = (key: string, value: string | null | undefined) => {
        if (!value) return;
        if (!allowedSet.has(key)) return;
        attributes[attrMapping[key] ?? key] = value;
    };

    setAttr("email", user.email);
    setAttr("username", user.username);
    setAttr("displayName", user.displayName);
    setAttr("givenName", user.givenName);
    setAttr("familyName", user.familyName);
    setAttr("surName", user.familyName);
    setAttr("phoneNumber", user.phoneNumber);

    // 서비스 role / 추가 attributes — allowedSet 검사를 동일하게 적용.
    if (spAssignment.role) {
        setAttr("Role", spAssignment.role.key);
        setAttr("RoleLabel", spAssignment.role.label);
    }
    const extraAttrs = parseAssignmentAttributes(spAssignment.attributesJson);
    for (const [k, v] of Object.entries(extraAttrs)) {
        if (typeof v === "string") {
            setAttr(k, v);
        } else if (v != null) {
            setAttr(k, String(v));
        }
    }

    // 조직 정보는 SP 가 명시적으로 허용한 경우에만 포함한다.
    const wantsOrg = allowedSet.has("department") || allowedSet.has("team") || allowedSet.has("jobTitle") || allowedSet.has("position");
    if (wantsOrg) {
        const membership = await getUserMembership(db, user.id);
        const primaryDept = membership.departments.find((d) => d.isPrimary) ?? membership.departments[0];
        const primaryTeam = membership.teams.find((t) => t.isPrimary) ?? membership.teams[0];
        if (primaryDept) {
            setAttr("department", primaryDept.name);
            setAttr("jobTitle", primaryDept.jobTitle);
            if (primaryDept.position) setAttr("position", primaryDept.position.name);
        }
        if (primaryTeam) {
            setAttr("team", primaryTeam.name);
        }
    }

    // NameID 결정
    const nameIdFormat = sp.nameIdFormat;
    const nameId = nameIdFormat === "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent" ? user.id : (user.email ?? user.id);

    const sessionIndex = `_si${crypto.randomUUID().replace(/-/g, "")}`;

    await recordSamlSession(db, {
        tenantId: tenant.id,
        spId: sp.id,
        userId: user.id,
        sessionId: session.id,
        sessionIndex,
        nameId,
        nameIdFormat,
    });

    const samlResponseB64 = await buildSignedSamlResponse({
        inResponseTo: p.inResponseTo, // null 이면 unsolicited — InResponseTo 생략
        acsUrl: p.acsUrl,
        issuerUrl: p.issuerUrl,
        spEntityId: sp.entityId,
        authnContextClassRef: session.acr ?? undefined,
        nameId,
        nameIdFormat,
        sessionIndex,
        attributes,
        certPem: p.certPem,
        privateKey: p.privateKey,
        signResponse: sp.signResponse,
        encryptAssertion: sp.encryptAssertion,
        spCertPem: sp.cert,
    });

    const requestMetadata = getRequestMetadata(event);
    await recordAuditEvent(db, {
        tenantId: tenant.id,
        userId: user.id,
        actorId: user.id,
        spOrClientId: sp.entityId,
        kind: "saml_sso",
        outcome: "success",
        ip: requestMetadata.ip,
        userAgent: requestMetadata.userAgent,
        detail: { spEntityId: sp.entityId, nameId, initiatedBy: p.inResponseTo ? "sp" : "idp" },
    });

    return renderAutoSubmitForm(p.acsUrl, samlResponseB64, p.relayState);
}

interface ProcessAuthnRequestParams {
    db: DB;
    tenant: Tenant;
    issuerUrl: string;
    sp: SamlSpRecord;
    authnRequest: ParsedAuthnRequest;
    acsUrl: string;
    certPem: string;
    privateKey: CryptoKey;
    /**
     * 미로그인/재인증 시 /login 으로 넘길 redirectTo (path+query). Redirect 바인딩은 현재
     * URL 그대로, POST 바인딩은 동일 AuthnRequest 를 Redirect 바인딩으로 재인코딩한 resume URL.
     */
    loginRedirectTo: string;
}

/**
 * SP-initiated AuthnRequest 공통 처리부 (Redirect / POST 바인딩 공유).
 * isPassive → 로그인 → forceAuthn → RequestedAuthnContext(ACR) → 게이트 → Response 발급.
 * 파싱·서명검증·바인딩별 redirectTo 만 호출부에서 다르게 준비해 넘긴다.
 */
async function processSpInitiatedAuthnRequest(event: Parameters<RequestHandler>[0], p: ProcessAuthnRequestParams): Promise<Response> {
    const { locals, url } = event;
    const { authnRequest, sp, acsUrl } = p;

    // isPassive: 사용자 인터랙션 없이 처리해야 하므로, 세션이 없으면 NoPassive 오류를 ACS 로 반환.
    if (authnRequest.isPassive && (!locals.user || !locals.session)) {
        return await buildAndRenderSamlError({
            inResponseTo: authnRequest.id,
            acsUrl,
            issuerUrl: p.issuerUrl,
            subStatusCode: "urn:oasis:names:tc:SAML:2.0:status:NoPassive",
            certPem: p.certPem,
            privateKey: p.privateKey,
            relayState: authnRequest.relayState,
        });
    }

    // 로그인 여부 확인 → 미로그인 시 로그인 페이지로
    if (!locals.user || !locals.session) {
        const loginUrl = new URL("/login", url);
        loginUrl.searchParams.set("redirectTo", p.loginRedirectTo);
        loginUrl.searchParams.set("skinHint", `saml:${sp.id}`);
        throw redirect(302, loginUrl.toString());
    }

    // forceAuthn: SP 가 강제 재인증을 요구하면, 현재 세션 상태와 무관하게 /login 으로 보낸다.
    // 무한 루프 방지: AuthnRequest ID 를 쿠키에 기록해 두고, 동일 요청에 대한 재진입이면 통과시킨다.
    if (authnRequest.forceAuthn) {
        const reauthCookieName = `saml_reauth_${authnRequest.id}`;
        const alreadyReauthed = event.cookies.get(reauthCookieName) === "1";
        if (!alreadyReauthed) {
            // 다음 요청에서 동일 AuthnRequest 가 들어오면 통과되도록 짧은 TTL 쿠키를 설정.
            event.cookies.set(reauthCookieName, "1", {
                path: "/saml/sso",
                httpOnly: true,
                sameSite: "lax",
                secure: url.protocol === "https:",
                maxAge: 600,
            });
            const loginUrl = new URL("/login", url);
            loginUrl.searchParams.set("redirectTo", p.loginRedirectTo);
            loginUrl.searchParams.set("skinHint", `saml:${sp.id}`);
            loginUrl.searchParams.set("forceAuthn", "true");
            throw redirect(302, loginUrl.toString());
        }
        // 이미 재인증을 거치고 돌아온 경우 — 쿠키 삭제 후 SSO 응답 진행
        event.cookies.delete(reauthCookieName, { path: "/saml/sso" });
    }

    // RequestedAuthnContext: 세션 ACR 이 SP 요구 수준을 만족하는지 검사한다.
    if (authnRequest.requestedAuthnContext && !acrSatisfies(locals.session.acr, authnRequest.requestedAuthnContext)) {
        // 세션이 issueInstant 이후에 생성됐다면 재인증을 이미 거쳤으나 ACR 이 여전히 부족한 것.
        // (예: MFA 미설정 사용자가 refeds/mfa 를 요구받은 경우) → NoAuthnContext 오류 반환.
        const isPostReauth = locals.session.createdAt >= authnRequest.issueInstant;
        if (isPostReauth || authnRequest.isPassive) {
            return await buildAndRenderSamlError({
                inResponseTo: authnRequest.id,
                acsUrl,
                issuerUrl: p.issuerUrl,
                subStatusCode: "urn:oasis:names:tc:SAML:2.0:status:NoAuthnContext",
                certPem: p.certPem,
                privateKey: p.privateKey,
                relayState: authnRequest.relayState,
            });
        }
        // 첫 시도: 재인증(MFA 포함)을 강제한다.
        const loginUrl = new URL("/login", url);
        loginUrl.searchParams.set("redirectTo", p.loginRedirectTo);
        loginUrl.searchParams.set("skinHint", `saml:${sp.id}`);
        loginUrl.searchParams.set("forceAuthn", "true");
        throw redirect(302, loginUrl.toString());
    }

    return await gateAndIssueSamlAssertion(event, {
        db: p.db,
        tenant: p.tenant,
        issuerUrl: p.issuerUrl,
        sp,
        user: locals.user,
        session: locals.session,
        acsUrl,
        inResponseTo: authnRequest.id,
        relayState: authnRequest.relayState,
        certPem: p.certPem,
        privateKey: p.privateKey,
    });
}

/**
 * IdP-initiated (unsolicited) SSO.
 * 로그인된 사용자가 `?sp=<entityId>` 로 SP 를 지정하면, 대응되는 AuthnRequest 없이
 * IdP 가 먼저 Assertion 을 SP 의 등록된 ACS 로 밀어 준다. InResponseTo 없음.
 */
async function handleIdpInitiated(event: Parameters<RequestHandler>[0], ctx: { db: DB; tenant: Tenant; issuerUrl: string; signingKeySecret: string; spEntityId: string }): Promise<Response> {
    const { locals, url } = event;
    const { db, tenant } = ctx;

    const sp = await findSp(db, tenant.id, ctx.spEntityId);
    if (!sp) {
        throw error(403, `등록되지 않은 SP 입니다: ${ctx.spEntityId}`);
    }

    // 미로그인 시 로그인 페이지로 (로그인 후 동일 IdP-initiated URL 로 복귀)
    if (!locals.user || !locals.session) {
        const loginUrl = new URL("/login", url);
        loginUrl.searchParams.set("redirectTo", url.pathname + url.search);
        loginUrl.searchParams.set("skinHint", `saml:${sp.id}`);
        throw redirect(302, loginUrl.toString());
    }

    const signingKey = await getActiveSigningKey(db, tenant.id, ctx.signingKeySecret);
    if (!signingKey || !signingKey.certPem) {
        throw error(503, "서명 키가 없습니다. 서버를 재시작하여 키를 생성하세요.");
    }

    const relayState = url.searchParams.get("RelayState");

    return await gateAndIssueSamlAssertion(event, {
        db,
        tenant,
        issuerUrl: ctx.issuerUrl,
        sp,
        user: locals.user,
        session: locals.session,
        acsUrl: sp.acsUrl, // 요청에 ACS 가 없으므로 등록된 SP ACS 사용
        inResponseTo: null, // unsolicited — InResponseTo 생략
        relayState,
        certPem: signingKey.certPem,
        privateKey: signingKey.privateKey,
    });
}

/**
 * 공통 진입부: rate-limit + config 검증. 통과 시 { db, tenant, config } 반환.
 * GET/POST 모두 동일한 IP당 30회/분 제한을 적용한다 (AuthnRequest 파싱·서명 검증 DoS 방지).
 */
async function ssoPreflight(event: Parameters<RequestHandler>[0]) {
    const { locals, platform } = event;
    const { db, tenant } = requireDbContext(locals);
    const config = getRuntimeConfig(platform);

    const { ipKey } = getRequestMetadata(event);
    const rl = await checkRateLimit(db, `saml-sso:${ipKey}`, { windowMs: 60 * 1000, limit: 30 });
    if (!rl.allowed) {
        throw error(429, "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
    }

    if (!config.issuerUrl) throw error(503, "IDP_ISSUER_URL 미설정");
    if (!config.signingKeySecret) throw error(503, "IDP_SIGNING_KEY_SECRET 미설정");

    return { db, tenant, issuerUrl: config.issuerUrl, signingKeySecret: config.signingKeySecret };
}

/** AuthnRequest Destination 이 IdP SSO endpoint 와 일치하는지 검증 (명시된 경우만). */
function assertDestination(authnRequest: ParsedAuthnRequest, issuerUrl: string): void {
    if (authnRequest.destination) {
        const expectedDestination = `${issuerUrl.replace(/\/+$/, "")}/saml/sso`;
        if (authnRequest.destination !== expectedDestination) {
            throw error(400, "AuthnRequest Destination 이 IdP 의 SSO endpoint 와 일치하지 않습니다.");
        }
    }
}

/** AuthnRequest 의 ACS URL 이 등록된 SP ACS 와 일치하는지 검증하고 최종 ACS 를 반환. */
function resolveAcsUrl(authnRequest: ParsedAuthnRequest, sp: SamlSpRecord): string {
    // AuthnRequest 에 ACS 가 명시된 경우 반드시 등록된 SP ACS 와 일치해야 한다.
    // 다른 URL 을 허용하면 공격자가 서명된 Assertion 을 자신의 서버로 가로챌 수 있다.
    if (authnRequest.acsUrl && authnRequest.acsUrl !== sp.acsUrl) {
        throw error(400, "AuthnRequest의 ACS URL이 등록된 SP ACS URL과 일치하지 않습니다.");
    }
    return sp.acsUrl;
}

/**
 * GET /saml/sso
 *   - SAMLRequest 있음 → SP-initiated / HTTP-Redirect 바인딩
 *   - SAMLRequest 없고 sp 있음 → IdP-initiated (unsolicited)
 */
export const GET: RequestHandler = async (event) => {
    const { url } = event;
    const { db, tenant, issuerUrl, signingKeySecret } = await ssoPreflight(event);

    const samlRequestB64 = url.searchParams.get("SAMLRequest");
    const relayState = url.searchParams.get("RelayState");

    // ── IdP-initiated 분기: SAMLRequest 없이 sp 파라미터만 존재 ─────────────────
    if (!samlRequestB64) {
        const spParam = url.searchParams.get("sp");
        if (spParam) {
            return await handleIdpInitiated(event, { db, tenant, issuerUrl, signingKeySecret, spEntityId: spParam });
        }
        throw error(400, "SAMLRequest 파라미터가 없습니다.");
    }

    // ── SP-initiated / HTTP-Redirect 바인딩 ────────────────────────────────────
    let authnRequest: ParsedAuthnRequest;
    try {
        authnRequest = await parseAuthnRequest(samlRequestB64, relayState);
    } catch {
        throw error(400, "SAMLRequest 파싱 실패");
    }

    assertDestination(authnRequest, issuerUrl);

    const sp = await findSp(db, tenant.id, authnRequest.issuer);
    if (!sp) {
        throw error(403, `등록되지 않은 SP 입니다: ${authnRequest.issuer}`);
    }

    // AuthnRequest 서명 검증: SP 가 서명을 요구하거나 Signature 파라미터가 있는 경우.
    // HTTP-Redirect 바인딩 서명은 URL 쿼리(SAMLRequest&RelayState&SigAlg) 에 대한 detached 서명.
    const hasSig = url.searchParams.has("Signature");
    if (sp.wantAuthnRequestsSigned || hasSig) {
        if (!sp.cert) {
            throw error(400, "SP 인증서가 등록되지 않아 AuthnRequest 서명을 검증할 수 없습니다.");
        }
        const rawQuery = url.search.slice(1);
        const sigValid = await verifySamlRedirectSignature(rawQuery, sp.cert);
        if (!sigValid) {
            throw error(400, "AuthnRequest 서명 검증에 실패했습니다.");
        }
    }

    const acsUrl = resolveAcsUrl(authnRequest, sp);

    const signingKey = await getActiveSigningKey(db, tenant.id, signingKeySecret);
    if (!signingKey || !signingKey.certPem) {
        throw error(503, "서명 키가 없습니다. 서버를 재시작하여 키를 생성하세요.");
    }

    return await processSpInitiatedAuthnRequest(event, {
        db,
        tenant,
        issuerUrl,
        sp,
        authnRequest,
        acsUrl,
        certPem: signingKey.certPem,
        privateKey: signingKey.privateKey,
        loginRedirectTo: url.pathname + url.search,
    });
};

/**
 * POST /saml/sso — SP-initiated / HTTP-POST 바인딩.
 * body: SAMLRequest=<base64(XML)> (deflate 없음), RelayState=...
 */
export const POST: RequestHandler = async (event) => {
    const { url } = event;
    const { db, tenant, issuerUrl, signingKeySecret } = await ssoPreflight(event);

    const form = await event.request.formData();
    const samlRequestB64 = typeof form.get("SAMLRequest") === "string" ? (form.get("SAMLRequest") as string) : null;
    const relayState = typeof form.get("RelayState") === "string" ? (form.get("RelayState") as string) : null;

    if (!samlRequestB64) {
        throw error(400, "SAMLRequest 파라미터가 없습니다.");
    }

    // HTTP-POST 바인딩: base64(XML), deflate 없음. 서명 검증·resume 재인코딩에 재사용하도록
    // XML 을 한 번만 디코드한다. 파서(parseAuthnRequestPost)와 서명 검증기가 동일한 원본
    // 문자열을 보게 해, 파싱 결과와 서명 대상이 분기되는 것을 막는다.
    let xml: string;
    try {
        const raw = atob(samlRequestB64);
        const bin = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bin[i] = raw.charCodeAt(i);
        xml = new TextDecoder().decode(bin);
    } catch {
        throw error(400, "SAMLRequest 파싱 실패");
    }

    let authnRequest: ParsedAuthnRequest;
    try {
        authnRequest = await parseAuthnRequestPost(samlRequestB64, relayState);
    } catch {
        throw error(400, "SAMLRequest 파싱 실패");
    }

    assertDestination(authnRequest, issuerUrl);

    const sp = await findSp(db, tenant.id, authnRequest.issuer);
    if (!sp) {
        throw error(403, `등록되지 않은 SP 입니다: ${authnRequest.issuer}`);
    }

    // ── 서명 검증 (HTTP-POST 바인딩) ───────────────────────────────────────────
    // POST 바인딩의 서명 AuthnRequest 는 URL 쿼리 서명이 아니라 요청 XML 내부의 enveloped
    // XML 서명(ds:Signature)이다. SP 가 서명을 요구(wantAuthnRequestsSigned)하거나 XML 에
    // 서명이 존재하면, 신뢰하는 SP 인증서(sp.cert) 공개키로만 enveloped 서명을 검증한다.
    // (KeyInfo 의 인증서는 신뢰하지 않음 — verify-xml-signature.ts 참조.)
    if (sp.wantAuthnRequestsSigned || authnRequest.hasSignature) {
        if (!sp.cert) {
            // 검증에 쓸 SP 인증서가 없으면 서명을 검증할 방법이 없다 → 거부.
            throw error(400, "SP 인증서가 등록되지 않아 AuthnRequest 서명을 검증할 수 없습니다.");
        }
        const sigValid = await verifyEnvelopedXmlSignature(xml, sp.cert);
        if (!sigValid) {
            throw error(400, "AuthnRequest 서명 검증에 실패했습니다.");
        }
    }

    const acsUrl = resolveAcsUrl(authnRequest, sp);

    const signingKey = await getActiveSigningKey(db, tenant.id, signingKeySecret);
    if (!signingKey || !signingKey.certPem) {
        throw error(503, "서명 키가 없습니다. 서버를 재시작하여 키를 생성하세요.");
    }

    // 로그인/재인증 후 복귀 URL: POST body 는 GET 리다이렉트로 보존되지 않으므로, 동일
    // AuthnRequest 를 HTTP-Redirect 바인딩으로 재인코딩해 기존 GET 경로가 그대로 재개하도록 한다.
    const resumeParams = new URLSearchParams();
    resumeParams.set("SAMLRequest", await encodeRedirectBindingSamlRequest(xml));
    if (relayState) resumeParams.set("RelayState", relayState);
    const loginRedirectTo = `${url.pathname}?${resumeParams.toString()}`;

    return await processSpInitiatedAuthnRequest(event, {
        db,
        tenant,
        issuerUrl,
        sp,
        authnRequest,
        acsUrl,
        certPem: signingKey.certPem,
        privateKey: signingKey.privateKey,
        loginRedirectTo,
    });
};
