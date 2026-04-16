/**
 * SAML 2.0 IdP Metadata XML 생성.
 * SP 등록 시 메타데이터 URL 을 제공하기 위해 사용.
 */

import { and, eq, isNull } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import { signingKeys } from '$lib/server/db/schema';

function pemToBase64(pem: string): string {
	return pem
		.replace(/-----BEGIN CERTIFICATE-----/, '')
		.replace(/-----END CERTIFICATE-----/, '')
		.replace(/\s+/g, '');
}

function xmlEscape(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export async function generateIdpMetadataXml(
	db: DB,
	tenantId: string,
	issuerUrl: string
): Promise<string> {
	const [keyRow] = await db
		.select({ certPem: signingKeys.certPem })
		.from(signingKeys)
		.where(
			and(
				eq(signingKeys.tenantId, tenantId),
				eq(signingKeys.active, true),
				isNull(signingKeys.rotatedAt)
			)
		)
		.limit(1);

	const ssoUrl = `${issuerUrl}/saml/sso`;
	const sloUrl = `${issuerUrl}/saml/slo`;

	const certB64 = keyRow?.certPem ? pemToBase64(keyRow.certPem) : '';
	const keyDescriptor = certB64
		? `<md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data>
          <ds:X509Certificate>${certB64}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>`
		: '';

	const validUntil = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

	return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor
  xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="${xmlEscape(issuerUrl)}"
  validUntil="${validUntil}">
  <md:IDPSSODescriptor
    WantAuthnRequestsSigned="false"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    ${keyDescriptor}
    <md:SingleLogoutService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
      Location="${xmlEscape(sloUrl)}"/>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>
    <md:SingleSignOnService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
      Location="${xmlEscape(ssoUrl)}"/>
    <md:SingleSignOnService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${xmlEscape(ssoUrl)}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}
