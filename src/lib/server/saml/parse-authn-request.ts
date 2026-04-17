/**
 * SAML HTTP-Redirect 바인딩 AuthnRequest 파싱.
 *
 * SAMLRequest 파라미터: base64(deflate-raw(AuthnRequest XML))
 * Workers 내장 DecompressionStream('deflate-raw') 으로 inflate, 외부 라이브러리 불필요.
 */

import 'reflect-metadata';
import { DOMParser } from '@xmldom/xmldom';
import { X509Certificate } from '@peculiar/x509';

const MAX_COMPRESSED_BYTES = 8 * 1024; // 8 KB
const MAX_DECOMPRESSED_BYTES = 64 * 1024; // 64 KB

async function inflateRaw(compressed: Uint8Array<ArrayBuffer>): Promise<string> {
	if (compressed.length > MAX_COMPRESSED_BYTES) {
		throw new Error(`SAMLRequest 압축 데이터가 너무 큽니다 (${compressed.length} > ${MAX_COMPRESSED_BYTES})`);
	}

	const ds = new DecompressionStream('deflate-raw');
	const writer = ds.writable.getWriter();
	const reader = ds.readable.getReader();

	writer.write(compressed);
	await writer.close();

	const chunks: Uint8Array[] = [];
	let totalSize = 0;
	let done = false;
	while (!done) {
		const { value, done: d } = await reader.read();
		if (value) {
			totalSize += value.length;
			if (totalSize > MAX_DECOMPRESSED_BYTES) {
				throw new Error(`SAMLRequest 압축 해제 크기가 너무 큽니다 (> ${MAX_DECOMPRESSED_BYTES})`);
			}
			chunks.push(value);
		}
		done = d;
	}

	const buf = new Uint8Array(totalSize);
	let offset = 0;
	for (const chunk of chunks) {
		buf.set(chunk, offset);
		offset += chunk.length;
	}

	return new TextDecoder().decode(buf);
}

/**
 * SAML HTTP-Redirect 바인딩 서명을 검증한다.
 * SP 인증서의 공개 키로 SigAlg + 서명을 확인한다.
 * rawQueryString: URL 의 '?' 이후 문자열 (URL 인코딩 그대로)
 */
export async function verifySamlRedirectSignature(rawQueryString: string, certPem: string): Promise<boolean> {
	try {
		const params = rawQueryString.split('&');
		const samlRequestPart = params.find((p) => p.startsWith('SAMLRequest='));
		const relayStatePart = params.find((p) => p.startsWith('RelayState='));
		const sigAlgPart = params.find((p) => p.startsWith('SigAlg='));
		const signaturePart = params.find((p) => p.startsWith('Signature='));

		if (!samlRequestPart || !sigAlgPart || !signaturePart) return false;

		const sigAlgValue = decodeURIComponent(sigAlgPart.slice(sigAlgPart.indexOf('=') + 1));
		const signatureB64 = decodeURIComponent(signaturePart.slice(signaturePart.indexOf('=') + 1));

		// 서명 대상 문자열: SAMLRequest[&RelayState]&SigAlg (원본 URL 인코딩 유지)
		const signedParts = [samlRequestPart];
		if (relayStatePart) signedParts.push(relayStatePart);
		signedParts.push(sigAlgPart);
		const signedString = signedParts.join('&');

		// SigAlg 에 따라 WebCrypto 알고리즘 결정 (SHA-1 은 하위 호환용으로만 허용)
		let algorithm: RsaHashedImportParams;
		if (sigAlgValue === 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256') {
			algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
		} else if (sigAlgValue === 'http://www.w3.org/2000/09/xmldsig#rsa-sha1') {
			algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' };
		} else {
			return false; // 지원하지 않는 알고리즘
		}

		// SP 인증서에서 공개 키(SPKI) 추출
		const cert = new X509Certificate(certPem);
		const spkiDer = cert.publicKey.rawData;
		const publicKey = await crypto.subtle.importKey('spki', spkiDer, algorithm, false, ['verify']);

		const sigBytes = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
		const enc = new TextEncoder();
		return await crypto.subtle.verify(algorithm, publicKey, sigBytes, enc.encode(signedString));
	} catch {
		return false;
	}
}

export interface RequestedAuthnContext {
	/** exact | minimum | maximum | better */
	comparison: string;
	/** 요청된 AuthnContextClassRef 목록 */
	classRefs: string[];
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
	/** true 이면 IdP 는 기존 세션을 무시하고 재인증을 강제해야 한다 */
	forceAuthn: boolean;
	/** true 이면 IdP 는 사용자 인터랙션 없이 처리해야 한다 (세션 없으면 NoPassive 반환) */
	isPassive: boolean;
	/** AuthnRequest 발급 시각 */
	issueInstant: Date;
	/** SP 가 요구하는 인증 수준 (없으면 null) */
	requestedAuthnContext: RequestedAuthnContext | null;
}

function parseBoolAttr(val: string | null): boolean {
	return val === 'true' || val === '1';
}

export async function parseAuthnRequest(samlRequestB64: string, relayState: string | null): Promise<ParsedAuthnRequest> {
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
	const forceAuthn = parseBoolAttr(root.getAttribute('ForceAuthn'));
	const isPassive = parseBoolAttr(root.getAttribute('IsPassive'));
	const issueInstantStr = root.getAttribute('IssueInstant') ?? '';
	const issueInstant = issueInstantStr ? new Date(issueInstantStr) : new Date();

	const issuerEls = doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'Issuer');
	const issuer = issuerEls[0]?.textContent?.trim() ?? '';

	// RequestedAuthnContext 파싱
	const racEls = doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:protocol', 'RequestedAuthnContext');
	let requestedAuthnContext: RequestedAuthnContext | null = null;
	const racEl = racEls[0];
	if (racEl) {
		const comparison = racEl.getAttribute('Comparison') ?? 'exact';
		const classRefEls = racEl.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'AuthnContextClassRef');
		const classRefs: string[] = [];
		for (let i = 0; i < classRefEls.length; i++) {
			const text = classRefEls[i]?.textContent?.trim();
			if (text) classRefs.push(text);
		}
		if (classRefs.length > 0) {
			requestedAuthnContext = { comparison, classRefs };
		}
	}

	return {
		id,
		issuer,
		acsUrl,
		relayState,
		forceAuthn,
		isPassive,
		issueInstant,
		requestedAuthnContext,
	};
}
