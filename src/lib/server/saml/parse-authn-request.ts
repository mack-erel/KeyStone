/**
 * SAML HTTP-Redirect 바인딩 AuthnRequest 파싱.
 *
 * SAMLRequest 파라미터: base64(deflate-raw(AuthnRequest XML))
 * Workers 내장 DecompressionStream('deflate-raw') 으로 inflate, 외부 라이브러리 불필요.
 */

import "reflect-metadata";
import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";
import { X509Certificate } from "@peculiar/x509";
import { env } from "$env/dynamic/private";

const MAX_COMPRESSED_BYTES = 8 * 1024; // 8 KB
const MAX_DECOMPRESSED_BYTES = 64 * 1024; // 64 KB

async function inflateRaw(compressed: Uint8Array<ArrayBuffer>): Promise<string> {
    if (compressed.length > MAX_COMPRESSED_BYTES) {
        throw new Error(`SAMLRequest 압축 데이터가 너무 큽니다 (${compressed.length} > ${MAX_COMPRESSED_BYTES})`);
    }

    const ds = new DecompressionStream("deflate-raw");
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
        const params = rawQueryString.split("&");
        // ctrls H-SAML-2: parameter pollution 가드. 동일 키가 2개 이상 등장하면
        // 서명 검증 대상과 실제 파싱 결과가 분기되어 위조 페이로드를 허용할
        // 수 있다 (SAMLRequest=A&SAMLRequest=B). 각 보호 파라미터는 최대 1회.
        const countOf = (name: string): number => params.filter((p) => p.startsWith(name + "=")).length;
        if (countOf("SAMLRequest") > 1) return false;
        if (countOf("SAMLResponse") > 1) return false;
        if (countOf("RelayState") > 1) return false;
        if (countOf("SigAlg") > 1) return false;
        if (countOf("Signature") > 1) return false;

        const samlRequestPart = params.find((p) => p.startsWith("SAMLRequest="));
        const relayStatePart = params.find((p) => p.startsWith("RelayState="));
        const sigAlgPart = params.find((p) => p.startsWith("SigAlg="));
        const signaturePart = params.find((p) => p.startsWith("Signature="));

        if (!samlRequestPart || !sigAlgPart || !signaturePart) return false;

        const sigAlgValue = decodeURIComponent(sigAlgPart.slice(sigAlgPart.indexOf("=") + 1));
        const signatureB64 = decodeURIComponent(signaturePart.slice(signaturePart.indexOf("=") + 1));

        // 서명 대상 문자열: SAMLRequest[&RelayState]&SigAlg (원본 URL 인코딩 유지)
        const signedParts = [samlRequestPart];
        if (relayStatePart) signedParts.push(relayStatePart);
        signedParts.push(sigAlgPart);
        const signedString = signedParts.join("&");

        // SigAlg 에 따라 WebCrypto 알고리즘 결정 (SHA-1 은 하위 호환용으로만 허용)
        let algorithm: RsaHashedImportParams;
        if (sigAlgValue === "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256") {
            algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
        } else if (sigAlgValue === "http://www.w3.org/2000/09/xmldsig#rsa-sha1") {
            // ctrls H-SAML-3: SHA-1 SigAlg 기본 거부 (NIST/IETF deprecated).
            // 레거시 SP 호환이 필요한 경우 환경변수 IDP_ALLOW_SAML_SHA1=true 로 명시 허용.
            // 향후 PR: samlSps 테이블에 allowSha1Signatures per-SP 플래그 추가 후
            // 본 분기 폐기.
            if (env.IDP_ALLOW_SAML_SHA1 !== "true") {
                return false;
            }
            console.warn("[saml] SHA-1 SigAlg 사용됨 — deprecated, SP 측 SHA-256 전환 권장");
            algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" };
        } else {
            return false; // 지원하지 않는 알고리즘
        }

        // SP 인증서에서 공개 키(SPKI) 추출
        const cert = new X509Certificate(certPem);
        const spkiDer = cert.publicKey.rawData;
        const publicKey = await crypto.subtle.importKey("spki", spkiDer, algorithm, false, ["verify"]);

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
    /** SP 의 entityId (Issuer 엘리먼트) — 정규화 전 원본 값 */
    issuer: string;
    /** SP 가 요청한 ACS URL (없을 경우 DB 에 등록된 값을 사용) */
    acsUrl: string | null;
    /** SP 가 명시한 Destination (없으면 null). IdP 는 자기 자신의 endpoint URL 과 일치하는지 검증해야 한다. */
    destination: string | null;
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
    /**
     * AuthnRequest 에 enveloped XML 서명(ds:Signature)이 포함되어 있는지 여부.
     * HTTP-POST 바인딩에서 서명 유무를 판별해 (검증기 부재 시) 거부 판단에 사용한다.
     * HTTP-Redirect 바인딩은 서명이 URL 쿼리에 실리므로 이 값은 통상 false 다.
     */
    hasSignature: boolean;
}

const ISSUE_INSTANT_SKEW_MS = 5 * 60 * 1000; // ±5분

function parseBoolAttr(val: string | null): boolean {
    return val === "true" || val === "1";
}

/**
 * HTTP-Redirect 바인딩 AuthnRequest 파싱.
 * SAMLRequest = base64(deflate-raw(XML)) → inflate 후 공통 파서로 위임.
 */
export async function parseAuthnRequest(samlRequestB64: string, relayState: string | null): Promise<ParsedAuthnRequest> {
    // HTTP-Redirect 바인딩은 표준 base64 (base64url 이 아님)
    const raw = atob(samlRequestB64);
    const binary = new Uint8Array(raw.length) as Uint8Array<ArrayBuffer>;
    for (let i = 0; i < raw.length; i++) binary[i] = raw.charCodeAt(i);
    const xml = await inflateRaw(binary);
    return parseAuthnRequestXml(xml, relayState);
}

/**
 * HTTP-POST 바인딩 AuthnRequest 파싱.
 * SAMLRequest = base64(XML) — deflate 없음. base64 디코드 후 곧바로 공통 파서로 위임한다.
 * 디코드된 XML 크기는 Redirect 바인딩의 inflate 상한과 동일하게 제한해 파싱 DoS 를 막는다.
 */
export async function parseAuthnRequestPost(samlRequestB64: string, relayState: string | null): Promise<ParsedAuthnRequest> {
    // HTTP-POST 바인딩도 표준 base64 (base64url 이 아님). deflate 는 적용하지 않는다.
    const raw = atob(samlRequestB64);
    if (raw.length > MAX_DECOMPRESSED_BYTES) {
        throw new Error(`SAMLRequest XML 이 너무 큽니다 (${raw.length} > ${MAX_DECOMPRESSED_BYTES})`);
    }
    const binary = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) binary[i] = raw.charCodeAt(i);
    const xml = new TextDecoder().decode(binary);
    return parseAuthnRequestXml(xml, relayState);
}

/**
 * HTTP-Redirect 바인딩 SAMLRequest 인코딩 (deflate-raw + base64).
 * HTTP-POST 요청을 로그인 후 재개(resume)할 때, 파싱된 AuthnRequest XML 을 Redirect 바인딩
 * URL 로 재인코딩해 기존 GET 경로를 그대로 재사용하기 위해 사용한다.
 */
export async function encodeRedirectBindingSamlRequest(xml: string): Promise<string> {
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    writer.write(new TextEncoder().encode(xml));
    await writer.close();

    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    while (!done) {
        const { value, done: d } = await reader.read();
        if (value) {
            total += value.length;
            chunks.push(value);
        }
        done = d;
    }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        buf.set(chunk, offset);
        offset += chunk.length;
    }
    // HTTP-Redirect 바인딩은 표준 base64 (base64url 이 아님)
    const b64 = btoa(Array.from(buf, (b) => String.fromCharCode(b)).join(""));
    return b64;
}

/**
 * 바인딩 무관 공통 AuthnRequest XML 파서.
 * DOCTYPE/ENTITY 차단, onErrorStopParsing, 필드 추출, IssueInstant skew 검증을 수행한다.
 */
async function parseAuthnRequestXml(xml: string, relayState: string | null): Promise<ParsedAuthnRequest> {
    // XXE / DTD 인젝션 방어: SAML 표준상 AuthnRequest 는 DOCTYPE/ENTITY 를 가질 수 없다.
    // @xmldom/xmldom 은 외부 entity 를 fetch 하지 않지만, 문서적으로 명시 차단해 두면
    // 추후 라이브러리 교체에도 안전하다.
    if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
        throw new Error("AuthnRequest 에 DOCTYPE/ENTITY 선언이 포함되어 있습니다.");
    }

    // ctrls H-SAML-5: xmldom 0.9 default 동작은 파싱 에러를 silent 로 무시하고 부분
    // 결과 반환 — 손상된 XML 이 정상으로 통과될 위험. onErrorStopParsing 으로 error
    // level 발생 시 즉시 throw 하도록 명시.
    const parser = new DOMParser({ onError: onErrorStopParsing });
    const doc = parser.parseFromString(xml, "text/xml");
    const root = doc.documentElement;

    if (!root) {
        throw new Error("AuthnRequest XML 파싱 실패: documentElement 없음");
    }

    const id = root.getAttribute("ID") ?? "";
    const acsUrl = root.getAttribute("AssertionConsumerServiceURL") ?? null;
    const destination = root.getAttribute("Destination") ?? null;
    const forceAuthn = parseBoolAttr(root.getAttribute("ForceAuthn"));
    const isPassive = parseBoolAttr(root.getAttribute("IsPassive"));
    const issueInstantStr = root.getAttribute("IssueInstant") ?? "";
    const issueInstant = issueInstantStr ? new Date(issueInstantStr) : new Date(NaN);

    // IssueInstant 가 없거나 파싱 불가, 또는 현재 시각 ±5분 범위를 벗어나면 거부 (replay 방지)
    if (!issueInstantStr || Number.isNaN(issueInstant.getTime())) {
        throw new Error("AuthnRequest IssueInstant 가 없거나 유효하지 않습니다.");
    }
    const skew = Math.abs(Date.now() - issueInstant.getTime());
    if (skew > ISSUE_INSTANT_SKEW_MS) {
        throw new Error(`AuthnRequest IssueInstant 가 허용 범위(±5분)를 벗어납니다 (skew=${skew}ms)`);
    }

    const issuerEls = doc.getElementsByTagNameNS("urn:oasis:names:tc:SAML:2.0:assertion", "Issuer");
    const issuer = (issuerEls[0]?.textContent?.trim() ?? "").trim();

    // RequestedAuthnContext 파싱
    const racEls = doc.getElementsByTagNameNS("urn:oasis:names:tc:SAML:2.0:protocol", "RequestedAuthnContext");
    let requestedAuthnContext: RequestedAuthnContext | null = null;
    const racEl = racEls[0];
    if (racEl) {
        const comparison = racEl.getAttribute("Comparison") ?? "exact";
        const classRefEls = racEl.getElementsByTagNameNS("urn:oasis:names:tc:SAML:2.0:assertion", "AuthnContextClassRef");
        const classRefs: string[] = [];
        for (let i = 0; i < classRefEls.length; i++) {
            const text = classRefEls[i]?.textContent?.trim();
            if (text) classRefs.push(text);
        }
        if (classRefs.length > 0) {
            requestedAuthnContext = { comparison, classRefs };
        }
    }

    // enveloped XML 서명(ds:Signature) 존재 여부. POST 바인딩에서 서명 유무 판별에 사용.
    const sigEls = doc.getElementsByTagNameNS("http://www.w3.org/2000/09/xmldsig#", "Signature");
    const hasSignature = sigEls.length > 0;

    return {
        id,
        issuer,
        acsUrl,
        destination,
        relayState,
        forceAuthn,
        isPassive,
        issueInstant,
        requestedAuthnContext,
        hasSignature,
    };
}
