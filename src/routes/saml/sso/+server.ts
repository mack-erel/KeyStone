/**
 * SAML 2.0 SP-Initiated SSO 엔드포인트.
 *
 * GET  /saml/sso?SAMLRequest=...&RelayState=...
 *   → AuthnRequest 파싱 → 로그인 확인 → SAML Response 생성 → ACS 로 HTTP-POST
 */

import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq, and } from 'drizzle-orm';
import { requireDbContext } from '$lib/server/auth/guards';
import { getRuntimeConfig } from '$lib/server/auth/runtime';
import { recordAuditEvent } from '$lib/server/audit';
import { samlSps, samlSessions } from '$lib/server/db/schema';
import { getActiveSigningKey } from '$lib/server/crypto/keys';
import { parseAuthnRequest } from '$lib/server/saml/parse-authn-request';
import { buildSignedSamlResponse } from '$lib/server/saml/response';

const SAML_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8시간

export const GET: RequestHandler = async ({ locals, url, platform }) => {
	const { db, tenant } = requireDbContext(locals);
	const config = getRuntimeConfig(platform);

	if (!config.issuerUrl) throw error(503, 'IDP_ISSUER_URL 미설정');
	if (!config.signingKeySecret) throw error(503, 'IDP_SIGNING_KEY_SECRET 미설정');

	const samlRequestB64 = url.searchParams.get('SAMLRequest');
	const relayState = url.searchParams.get('RelayState');

	if (!samlRequestB64) {
		throw error(400, 'SAMLRequest 파라미터가 없습니다.');
	}

	// AuthnRequest 파싱
	let authnRequest;
	try {
		authnRequest = await parseAuthnRequest(samlRequestB64, relayState);
	} catch {
		throw error(400, 'SAMLRequest 파싱 실패');
	}

	// SP 조회 (entityId = issuer)
	const [sp] = await db
		.select()
		.from(samlSps)
		.where(
			and(
				eq(samlSps.tenantId, tenant.id),
				eq(samlSps.entityId, authnRequest.issuer),
				eq(samlSps.enabled, true)
			)
		)
		.limit(1);

	if (!sp) {
		throw error(403, `등록되지 않은 SP 입니다: ${authnRequest.issuer}`);
	}

	// 로그인 여부 확인 → 미로그인 시 로그인 페이지로
	if (!locals.user || !locals.session) {
		const loginUrl = new URL('/login', url);
		loginUrl.searchParams.set('redirectTo', url.pathname + url.search);
		throw redirect(302, loginUrl.toString());
	}

	// ACS URL: AuthnRequest 에 명시됐으면 사용, 없으면 DB 값 사용
	const acsUrl = authnRequest.acsUrl ?? sp.acsUrl;

	// 서명 키 조회
	const signingKey = await getActiveSigningKey(db, tenant.id, config.signingKeySecret);
	if (!signingKey || !signingKey.certPem) {
		throw error(503, '서명 키가 없습니다. 서버를 재시작하여 키를 생성하세요.');
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

	// 기본 attribute: email / username / displayName
	const user = locals.user;
	const attributes: Record<string, string> = {};

	const emailAttrName = attrMapping['email'] ?? 'email';
	const usernameAttrName = attrMapping['username'] ?? 'username';
	const displayNameAttrName = attrMapping['displayName'] ?? 'displayName';

	if (user.email) attributes[emailAttrName] = user.email;
	if (user.username) attributes[usernameAttrName] = user.username;
	if (user.displayName) attributes[displayNameAttrName] = user.displayName;

	// NameID 결정
	const nameIdFormat = sp.nameIdFormat;
	const nameId =
		nameIdFormat === 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'
			? user.id
			: (user.email ?? user.id);

	// SAML SessionIndex
	const sessionIndex = `_si${crypto.randomUUID().replace(/-/g, '')}`;
	const notOnOrAfter = new Date(Date.now() + SAML_SESSION_TTL_MS);

	// saml_sessions 기록
	await db.insert(samlSessions).values({
		id: crypto.randomUUID(),
		tenantId: tenant.id,
		spId: sp.id,
		userId: user.id,
		sessionId: locals.session.id,
		sessionIndex,
		nameId,
		nameIdFormat,
		notOnOrAfter
	});

	// SAML Response 빌드 및 서명
	const samlResponseB64 = await buildSignedSamlResponse({
		inResponseTo: authnRequest.id,
		acsUrl,
		issuerUrl: config.issuerUrl,
		spEntityId: sp.entityId,
		nameId,
		nameIdFormat,
		sessionIndex,
		attributes,
		certPem: signingKey.certPem,
		privateKey: signingKey.privateKey
	});

	await recordAuditEvent(db, {
		tenantId: tenant.id,
		userId: user.id,
		actorId: user.id,
		spOrClientId: sp.entityId,
		kind: 'saml_sso',
		outcome: 'success',
		detail: { spEntityId: sp.entityId, nameId }
	});

	// HTTP-POST 바인딩: auto-submit 폼 렌더링
	const relayStateInput = relayState
		? `<input type="hidden" name="RelayState" value="${relayState.replace(/"/g, '&quot;')}">`
		: '';

	const html = `<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"><title>SSO 리다이렉트 중...</title></head>
<body>
<form id="samlForm" method="POST" action="${acsUrl.replace(/"/g, '&quot;')}">
  <input type="hidden" name="SAMLResponse" value="${samlResponseB64}">
  ${relayStateInput}
</form>
<script>document.getElementById('samlForm').submit();</script>
</body>
</html>`;

	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' }
	});
};
