/**
 * SAML 2.0 Response 빌드 및 Assertion 서명.
 *
 * - Assertion 에만 서명 (enveloped + exc-c14n, RSA-SHA256)
 * - xmldsigjs 의 URI="#assertionId" 참조 방식으로 표준 준수
 * - Response 는 base64 인코딩하여 HTTP-POST 바인딩용 SAMLResponse 값으로 반환
 */

import { ensureXmlEngine, xmldsigjs } from './xml-setup';

function xmlEscape(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function toIso(d: Date): string {
	return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function pemToBase64(pem: string): string {
	return pem
		.replace(/-----BEGIN CERTIFICATE-----/, '')
		.replace(/-----END CERTIFICATE-----/, '')
		.replace(/\s+/g, '');
}

export interface BuildSamlResponseParams {
	/** AuthnRequest 의 ID (InResponseTo) */
	inResponseTo: string;
	/** SP 의 ACS URL */
	acsUrl: string;
	/** IdP issuer URL (entityID) */
	issuerUrl: string;
	/** SP 의 entityID (Audience) */
	spEntityId: string;
	/** NameID 값 (보통 email) */
	nameId: string;
	/** NameID 포맷 */
	nameIdFormat: string;
	/** SAML SessionIndex */
	sessionIndex: string;
	/** 추가 Attribute (name → value) */
	attributes: Record<string, string>;
	/** IdP 인증서 PEM */
	certPem: string;
	/** 서명용 private key */
	privateKey: CryptoKey;
}

export async function buildSignedSamlResponse(params: BuildSamlResponseParams): Promise<string> {
	ensureXmlEngine();

	const now = new Date();
	const responseId = `_r${crypto.randomUUID().replace(/-/g, '')}`;
	const assertionId = `_a${crypto.randomUUID().replace(/-/g, '')}`;
	const issueInstant = toIso(now);
	const notBefore = toIso(new Date(now.getTime() - 30_000));
	const notOnOrAfter = toIso(new Date(now.getTime() + 5 * 60 * 1000));
	const sessionNotOnOrAfter = toIso(new Date(now.getTime() + 8 * 60 * 60 * 1000));
	const certB64 = pemToBase64(params.certPem);

	const attributeStmtXml = Object.keys(params.attributes).length
		? `<saml:AttributeStatement>` +
			Object.entries(params.attributes)
				.map(
					([name, value]) =>
						`<saml:Attribute Name="${xmlEscape(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">` +
						`<saml:AttributeValue xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${xmlEscape(value)}</saml:AttributeValue>` +
						`</saml:Attribute>`
				)
				.join('') +
			`</saml:AttributeStatement>`
		: '';

	// Assertion XML (서명 전)
	const assertionXml =
		`<saml:Assertion` +
		` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
		` xmlns:xs="http://www.w3.org/2001/XMLSchema"` +
		` ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant}">` +
		`<saml:Issuer>${xmlEscape(params.issuerUrl)}</saml:Issuer>` +
		`<saml:Subject>` +
		`<saml:NameID Format="${xmlEscape(params.nameIdFormat)}">${xmlEscape(params.nameId)}</saml:NameID>` +
		`<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
		`<saml:SubjectConfirmationData` +
		` InResponseTo="${xmlEscape(params.inResponseTo)}"` +
		` NotOnOrAfter="${notOnOrAfter}"` +
		` Recipient="${xmlEscape(params.acsUrl)}"/>` +
		`</saml:SubjectConfirmation>` +
		`</saml:Subject>` +
		`<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
		`<saml:AudienceRestriction><saml:Audience>${xmlEscape(params.spEntityId)}</saml:Audience></saml:AudienceRestriction>` +
		`</saml:Conditions>` +
		`<saml:AuthnStatement AuthnInstant="${issueInstant}"` +
		` SessionIndex="${xmlEscape(params.sessionIndex)}"` +
		` SessionNotOnOrAfter="${sessionNotOnOrAfter}">` +
		`<saml:AuthnContext>` +
		`<saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>` +
		`</saml:AuthnContext>` +
		`</saml:AuthnStatement>` +
		attributeStmtXml +
		`</saml:Assertion>`;

	// Assertion 서명 (xmldsigjs)
	const assertionDoc = xmldsigjs.Parse(assertionXml);
	const signedXml = new xmldsigjs.SignedXml();
	await signedXml.Sign({ name: 'RSASSA-PKCS1-v1_5' }, params.privateKey, assertionDoc, {
		x509: [certB64],
		references: [
			{
				uri: `#${assertionId}`,
				hash: 'SHA-256',
				transforms: ['enveloped', 'exc-c14n']
			}
		]
	});

	const sigNode = signedXml.XmlSignature.GetXml();
	if (sigNode) {
		assertionDoc.documentElement.appendChild(sigNode);
	}
	// XML 선언부 제거 후 직렬화
	const signedAssertion = xmldsigjs.Stringify(assertionDoc).replace(/^<\?xml[^?]*\?>\s*/i, '');

	// Response 조립 (Assertion 서명만, Response 자체는 unsigned)
	const responseXml =
		`<samlp:Response` +
		` xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"` +
		` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
		` ID="${responseId}" Version="2.0" IssueInstant="${issueInstant}"` +
		` InResponseTo="${xmlEscape(params.inResponseTo)}"` +
		` Destination="${xmlEscape(params.acsUrl)}">` +
		`<saml:Issuer>${xmlEscape(params.issuerUrl)}</saml:Issuer>` +
		`<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
		signedAssertion +
		`</samlp:Response>`;

	// HTTP-POST 바인딩: base64 인코딩
	return btoa(unescape(encodeURIComponent(responseXml)));
}
