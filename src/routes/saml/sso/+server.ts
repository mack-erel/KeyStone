/**
 * SAML 2.0 SP-Initiated SSO 엔드포인트.
 *
 * GET  /saml/sso?SAMLRequest=...&RelayState=...
 *   → AuthnRequest 파싱 → 로그인 확인 → SAML Response 생성 → ACS 로 HTTP-POST
 */

import { error, redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit";
import { checkRateLimit } from "$lib/server/ratelimit";
import { getActiveSigningKey } from "$lib/server/crypto/keys";
import { acrSatisfies } from "$lib/server/auth/constants";
import { parseAuthnRequest, verifySamlRedirectSignature } from "$lib/server/saml/parse-authn-request";
import { buildSignedSamlErrorResponse, buildSignedSamlResponse } from "$lib/server/saml/response";
import { findSp, recordSamlSession } from "$lib/server/saml/sp";
import { getUserMembership } from "$lib/server/org/membership";

export const GET: RequestHandler = async (event) => {
    const { locals, url, platform } = event;
    const { db, tenant } = requireDbContext(locals);
    const config = getRuntimeConfig(platform);

    // IP당 30회/분 — AuthnRequest 파싱·서명 검증 연산 DoS 방지
    const { ip } = getRequestMetadata(event);
    const rl = await checkRateLimit(db, `saml-sso:${ip ?? "unknown"}`, { windowMs: 60 * 1000, limit: 30 });
    if (!rl.allowed) {
        throw error(429, "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.");
    }

    if (!config.issuerUrl) throw error(503, "IDP_ISSUER_URL 미설정");
    if (!config.signingKeySecret) throw error(503, "IDP_SIGNING_KEY_SECRET 미설정");

    const samlRequestB64 = url.searchParams.get("SAMLRequest");
    const relayState = url.searchParams.get("RelayState");

    if (!samlRequestB64) {
        throw error(400, "SAMLRequest 파라미터가 없습니다.");
    }

    // AuthnRequest 파싱
    let authnRequest;
    try {
        authnRequest = await parseAuthnRequest(samlRequestB64, relayState);
    } catch {
        throw error(400, "SAMLRequest 파싱 실패");
    }

    const sp = await findSp(db, tenant.id, authnRequest.issuer);
    if (!sp) {
        throw error(403, `등록되지 않은 SP 입니다: ${authnRequest.issuer}`);
    }

    // AuthnRequest 서명 검증: SP 가 서명을 요구하거나 Signature 파라미터가 있는 경우
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

    // ACS URL: AuthnRequest 에 명시된 경우 반드시 등록된 SP의 ACS URL 과 일치해야 한다.
    // 다른 URL 을 허용하면 공격자가 서명된 Assertion 을 자신의 서버로 가로챌 수 있다.
    if (authnRequest.acsUrl && authnRequest.acsUrl !== sp.acsUrl) {
        throw error(400, "AuthnRequest의 ACS URL이 등록된 SP ACS URL과 일치하지 않습니다.");
    }
    const acsUrl = sp.acsUrl;

    const signingKey = await getActiveSigningKey(db, tenant.id, config.signingKeySecret);
    if (!signingKey || !signingKey.certPem) {
        throw error(503, "서명 키가 없습니다. 서버를 재시작하여 키를 생성하세요.");
    }

    // isPassive: 사용자 인터랙션 없이 처리해야 하므로, 세션이 없으면 NoPassive 오류를 ACS 로 반환.
    if (authnRequest.isPassive && (!locals.user || !locals.session)) {
        const errorB64 = await buildSignedSamlErrorResponse({
            inResponseTo: authnRequest.id,
            acsUrl,
            issuerUrl: config.issuerUrl,
            subStatusCode: "urn:oasis:names:tc:SAML:2.0:status:NoPassive",
            certPem: signingKey.certPem,
            privateKey: signingKey.privateKey,
        });
        const relayStateInput = authnRequest.relayState ? `<input type="hidden" name="RelayState" value="${htmlEscape(authnRequest.relayState)}">` : "";
        return new Response(
            `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>SSO 리다이렉트 중...</title></head>` +
                `<body onload="document.getElementById('samlForm').submit()">` +
                `<form id="samlForm" method="POST" action="${htmlEscape(acsUrl)}">` +
                `<input type="hidden" name="SAMLResponse" value="${errorB64}">${relayStateInput}` +
                `</form></body></html>`,
            { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
    }

    // 로그인 여부 확인 → 미로그인 시 로그인 페이지로
    if (!locals.user || !locals.session) {
        const loginUrl = new URL("/login", url);
        loginUrl.searchParams.set("redirectTo", url.pathname + url.search);
        loginUrl.searchParams.set("skinHint", `saml:${sp.id}`);
        throw redirect(302, loginUrl.toString());
    }

    // forceAuthn: 세션이 AuthnRequest 발급 이전에 생성된 경우 재인증을 강제한다.
    // 로그인 후 새 세션의 createdAt > issueInstant 이므로 자연스럽게 루프가 끊긴다.
    if (authnRequest.forceAuthn && locals.session.createdAt < authnRequest.issueInstant) {
        const loginUrl = new URL("/login", url);
        loginUrl.searchParams.set("redirectTo", url.pathname + url.search);
        loginUrl.searchParams.set("skinHint", `saml:${sp.id}`);
        loginUrl.searchParams.set("forceAuthn", "true");
        throw redirect(302, loginUrl.toString());
    }

    // RequestedAuthnContext: 세션 ACR 이 SP 요구 수준을 만족하는지 검사한다.
    if (authnRequest.requestedAuthnContext && !acrSatisfies(locals.session.acr, authnRequest.requestedAuthnContext)) {
        // 세션이 issueInstant 이후에 생성됐다면 재인증을 이미 거쳤으나 ACR 이 여전히 부족한 것.
        // (예: MFA 미설정 사용자가 refeds/mfa 를 요구받은 경우) → NoAuthnContext 오류 반환.
        const isPostReauth = locals.session.createdAt >= authnRequest.issueInstant;
        if (isPostReauth || authnRequest.isPassive) {
            const errorB64 = await buildSignedSamlErrorResponse({
                inResponseTo: authnRequest.id,
                acsUrl,
                issuerUrl: config.issuerUrl,
                subStatusCode: "urn:oasis:names:tc:SAML:2.0:status:NoAuthnContext",
                certPem: signingKey.certPem,
                privateKey: signingKey.privateKey,
            });
            const relayStateInput = authnRequest.relayState ? `<input type="hidden" name="RelayState" value="${htmlEscape(authnRequest.relayState)}">` : "";
            return new Response(
                `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>SSO 리다이렉트 중...</title></head>` +
                    `<body onload="document.getElementById('samlForm').submit()">` +
                    `<form id="samlForm" method="POST" action="${htmlEscape(acsUrl)}">` +
                    `<input type="hidden" name="SAMLResponse" value="${errorB64}">${relayStateInput}` +
                    `</form></body></html>`,
                { headers: { "Content-Type": "text/html; charset=utf-8" } },
            );
        }
        // 첫 시도: 재인증(MFA 포함)을 강제한다.
        const loginUrl = new URL("/login", url);
        loginUrl.searchParams.set("redirectTo", url.pathname + url.search);
        loginUrl.searchParams.set("skinHint", `saml:${sp.id}`);
        loginUrl.searchParams.set("forceAuthn", "true");
        throw redirect(302, loginUrl.toString());
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

    const user = locals.user;
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
        sessionId: locals.session.id,
        sessionIndex,
        nameId,
        nameIdFormat,
    });

    const samlResponseB64 = await buildSignedSamlResponse({
        inResponseTo: authnRequest.id,
        acsUrl,
        issuerUrl: config.issuerUrl,
        spEntityId: sp.entityId,
        authnContextClassRef: locals.session.acr ?? undefined,
        nameId,
        nameIdFormat,
        sessionIndex,
        attributes,
        certPem: signingKey.certPem,
        privateKey: signingKey.privateKey,
        signResponse: sp.signResponse,
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
        detail: { spEntityId: sp.entityId, nameId },
    });

    // HTTP-POST 바인딩: auto-submit 폼 렌더링
    function htmlEscape(s: string): string {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    const relayStateInput = relayState ? `<input type="hidden" name="RelayState" value="${htmlEscape(relayState)}">` : "";

    const html = `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"><title>SSO 리다이렉트 중...</title></head>
<body onload="document.getElementById('samlForm').submit()">
<form id="samlForm" method="POST" action="${htmlEscape(acsUrl)}">
  <input type="hidden" name="SAMLResponse" value="${samlResponseB64}">
  ${relayStateInput}
</form>
</body>
</html>`;

    return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
    });
};
