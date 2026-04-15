import { json } from '@sveltejs/kit';
import * as xmldsigjs from 'xmldsigjs';

/**
 * PoC: SAML Assertion 서명을 `xmldsigjs` 로 실제 수행.
 *
 * 확인 대상:
 *  - xmldsigjs + @xmldom/xmldom 이 Cloudflare Workers 런타임에서 번들·동작하는가
 *  - enveloped + exc-c14n 변환이 정상 수행되는가
 *  - RSA-SHA256 서명/검증이 라이브러리 경로로 왕복 통과하는가
 *
 * GET /poc/saml-sign
 */
export const GET = async () => {
	// Workers 의 native crypto 를 xmldsigjs 엔진으로 주입.
	// 타입은 peculiar/webcrypto Crypto 를 기대하지만, 구조가 동일하므로 캐스팅.
	xmldsigjs.Application.setEngine('WorkersWebCrypto', crypto as unknown as Crypto);

	const t0 = Date.now();

	const keys = await crypto.subtle.generateKey(
		{
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256'
		},
		true,
		['sign', 'verify']
	);
	const tKey = Date.now();

	const assertionXml =
		'<Assertion xmlns="urn:oasis:names:tc:SAML:2.0:assertion" ID="_abc" IssueInstant="2026-04-15T00:00:00Z">' +
		'<Issuer>https://idp.example</Issuer>' +
		'<Subject><NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">user@example.com</NameID></Subject>' +
		'</Assertion>';

	const doc = xmldsigjs.Parse(assertionXml);

	const signedXml = new xmldsigjs.SignedXml();
	await signedXml.Sign({ name: 'RSASSA-PKCS1-v1_5' }, keys.privateKey, doc, {
		keyValue: keys.publicKey,
		references: [
			{
				hash: 'SHA-256',
				transforms: ['enveloped', 'exc-c14n']
			}
		]
	});

	// Sign() 은 서명 요소만 반환하므로, 문서 루트에 삽입한 뒤 직렬화.
	const sigNode = signedXml.XmlSignature.GetXml();
	if (sigNode) {
		doc.documentElement.appendChild(sigNode);
	}
	const signedString = xmldsigjs.Stringify(doc);
	const tSign = Date.now();

	// 검증 라운드트립
	const parsedAgain = xmldsigjs.Parse(signedString);
	const sigEls = parsedAgain.getElementsByTagNameNS(
		'http://www.w3.org/2000/09/xmldsig#',
		'Signature'
	);
	const verifier = new xmldsigjs.SignedXml(parsedAgain);
	verifier.LoadXml(sigEls[0]);
	const verified = await verifier.Verify();
	const tVerify = Date.now();

	return json({
		verified,
		algorithm: 'RSASSA-PKCS1-v1_5 / SHA-256',
		canonicalization: 'exc-c14n + enveloped',
		signedXmlLength: signedString.length,
		signedXmlPreview: signedString.slice(0, 400) + (signedString.length > 400 ? '...' : ''),
		timingMs: {
			keygen: tKey - t0,
			sign: tSign - tKey,
			verify: tVerify - tSign,
			total: tVerify - t0
		}
	});
};
