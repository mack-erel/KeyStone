/**
 * SAML HTTP-Redirect 바인딩 AuthnRequest 파싱.
 *
 * SAMLRequest 파라미터: base64(deflate-raw(AuthnRequest XML))
 * Workers 내장 DecompressionStream('deflate-raw') 으로 inflate, 외부 라이브러리 불필요.
 */

import { DOMParser } from '@xmldom/xmldom';

async function inflateRaw(compressed: Uint8Array<ArrayBuffer>): Promise<string> {
	const ds = new DecompressionStream('deflate-raw');
	const writer = ds.writable.getWriter();
	const reader = ds.readable.getReader();

	writer.write(compressed);
	await writer.close();

	const chunks: Uint8Array[] = [];
	let done = false;
	while (!done) {
		const { value, done: d } = await reader.read();
		if (value) chunks.push(value);
		done = d;
	}

	const total = chunks.reduce((sum, c) => sum + c.length, 0);
	const buf = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		buf.set(chunk, offset);
		offset += chunk.length;
	}

	return new TextDecoder().decode(buf);
}

export interface ParsedAuthnRequest {
	/** AuthnRequest 의 ID 속성 */
	id: string;
	/** SP 의 entityId (Issuer 엘리먼트) */
	issuer: string;
	/** SP 가 요청한 ACS URL (없을 경우 DB 에 등록된 값을 사용) */
	acsUrl: string | null;
	/** 원본 RelayState 쿼리 파라미터 */
	relayState: string | null;
}

export async function parseAuthnRequest(
	samlRequestB64: string,
	relayState: string | null
): Promise<ParsedAuthnRequest> {
	// HTTP-Redirect 바인딩은 표준 base64 (base64url 이 아님)
	const raw = atob(samlRequestB64);
	const binary = new Uint8Array(raw.length) as Uint8Array<ArrayBuffer>;
	for (let i = 0; i < raw.length; i++) binary[i] = raw.charCodeAt(i);
	const xml = await inflateRaw(binary);

	const parser = new DOMParser();
	const doc = parser.parseFromString(xml, 'text/xml');
	const root = doc.documentElement;

	if (!root) {
		throw new Error('AuthnRequest XML 파싱 실패: documentElement 없음');
	}

	const id = root.getAttribute('ID') ?? '';
	const acsUrl = root.getAttribute('AssertionConsumerServiceURL') ?? null;

	const issuerEls = doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'Issuer');
	const issuer = issuerEls[0]?.textContent?.trim() ?? '';

	return { id, issuer, acsUrl, relayState };
}
