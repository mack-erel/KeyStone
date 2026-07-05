/**
 * Enveloped XML 서명(ds:Signature) 검증 — HTTP-POST 바인딩 AuthnRequest 용.
 *
 * HTTP-Redirect 바인딩은 서명이 URL 쿼리에 detached 로 실리지만(verifySamlRedirectSignature),
 * HTTP-POST 바인딩의 서명 AuthnRequest 는 요청 XML 내부에 enveloped ds:Signature 로 실린다.
 * 이 모듈은 xmldsigjs 로 그 서명을 검증한다.
 *
 * 신뢰 모델 (매우 중요):
 *   - 검증 키는 **오직 우리가 등록·신뢰하는 SP 인증서(certPem)의 공개키**만 사용한다.
 *   - XML 내부 <ds:KeyInfo> 의 인증서는 절대 신뢰하지 않는다. 공격자가 자기 키로 서명하고
 *     자기 인증서를 KeyInfo 에 심으면, KeyInfo 를 신뢰할 경우 위조가 통과되기 때문이다.
 *   - xmldsigjs 의 SignedXml.Verify(publicKey) 는 인자로 키를 넘기면 KeyInfo(GetPublicKeys)를
 *     쓰지 않고 그 키로만 검증한다(signed_xml.js: `const keys = key ? [key] : GetPublicKeys()`).
 *
 * 서명 래핑(XML Signature Wrapping, XSW) 방어:
 *   1. 문서 내 <ds:Signature> 는 정확히 1개여야 하며, 문서 루트(AuthnRequest)의 직계 자식이어야 한다
 *      (enveloped 서명이 루트를 감싼다).
 *   2. SignedInfo 의 Reference 는 정확히 1개여야 하며, 그 URI 는 문서 루트의 실제 ID(`#<rootID>`)를
 *      가리켜야 한다. 다른 요소(주입된 wrapper)를 가리키는 서명은 거부한다.
 *   3. 그 Reference 에 enveloped-signature transform 이 포함되어야 한다.
 *   4. xmldsigjs 내부의 중복 ID 감지(findAllByIdExcludingSignatures)가 동일 ID 를 가진 두 요소를
 *      발견하면 예외를 던진다 — wrapper 로 동일 ID 를 복제하는 공격을 차단한다.
 *   5. 서명/다이제스트 알고리즘은 SHA-256 이상만 허용한다(레거시 SHA-1 은 명시 옵트인 시만).
 *
 * ⚠ 이 검증은 우리(IdP)가 자체적으로 수행할 수 있는 암호 검증까지만 보장한다. 실제 SP 상호운용
 *   (SP 가 실제로 어떤 c14n/transform/서명 배치를 쓰는지)은 별도의 interop 테스트가 필요하다.
 */

import "reflect-metadata";
import { X509Certificate } from "@peculiar/x509";
import { env } from "$env/dynamic/private";
import { ensureXmlEngine, xmldsigjs } from "./xml-setup";

const XMLDSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const ENVELOPED_TRANSFORM = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

// 허용 SignatureMethod (SHA-256 이상). SHA-1 은 IDP_ALLOW_SAML_SHA1=true 일 때만 예외 허용.
const ALLOWED_SIG_METHODS = new Set(["http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384", "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512"]);
const SHA1_SIG_METHOD = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";

// 허용 DigestMethod (SHA-256 이상). SHA-1 은 동일하게 옵트인 시만.
const ALLOWED_DIGEST_METHODS = new Set(["http://www.w3.org/2001/04/xmlenc#sha256", "http://www.w3.org/2001/04/xmldsig-more#sha384", "http://www.w3.org/2001/04/xmlenc#sha512"]);
const SHA1_DIGEST_METHOD = "http://www.w3.org/2000/09/xmldsig#sha1";

function sha1Allowed(): boolean {
    return env.IDP_ALLOW_SAML_SHA1 === "true";
}

/**
 * AuthnRequest XML 의 enveloped ds:Signature 를 SP 인증서 공개키로 검증한다.
 * 검증 불가·형식 위반·서명 불일치 시 예외 없이 false 를 반환한다 (호출부는 false → 거부).
 *
 * @param xml     AuthnRequest 원본 XML 문자열 (base64 디코드 후, deflate 없음)
 * @param certPem 신뢰하는 SP 인증서(PEM). 이 인증서의 공개키로만 검증한다.
 */
export async function verifyEnvelopedXmlSignature(xml: string, certPem: string): Promise<boolean> {
    try {
        if (!certPem) return false;
        ensureXmlEngine();

        // DOCTYPE/ENTITY 방어(호출 전 파서에서 이미 차단되지만 이중 방어).
        if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) return false;

        const doc = xmldsigjs.Parse(xml);
        const root = doc.documentElement;
        if (!root) return false;

        // 서명 대상 식별: 루트의 ID 속성. 없으면 무엇이 서명됐는지 확정할 수 없어 거부.
        const rootId = root.getAttribute("ID");
        if (!rootId) return false;

        // XSW 방어 (1): Signature 는 정확히 1개, 루트의 직계 자식이어야 한다.
        const sigEls = doc.getElementsByTagNameNS(XMLDSIG_NS, "Signature");
        if (sigEls.length !== 1) return false;
        const sigEl = sigEls[0];
        if (!sigEl || sigEl.parentNode !== root) return false;

        // 신뢰하는 SP 인증서의 공개키. extractable=true — xmldsigjs Verify 내부에서
        // SignatureMethod 에 맞춰 키를 재-import 하려고 SPKI 를 export 하기 때문.
        const cert = new X509Certificate(certPem);
        const publicKey = await crypto.subtle.importKey("spki", cert.publicKey.rawData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]);

        const signedXml = new xmldsigjs.SignedXml(doc);
        signedXml.LoadXml(sigEl);

        const signedInfo = signedXml.XmlSignature.SignedInfo;

        // 알고리즘 화이트리스트 (SignatureMethod).
        const sigMethod = signedInfo.SignatureMethod?.Algorithm ?? "";
        if (!ALLOWED_SIG_METHODS.has(sigMethod) && !(sigMethod === SHA1_SIG_METHOD && sha1Allowed())) {
            return false;
        }

        // XSW 방어 (2): Reference 는 정확히 1개, URI 는 문서 루트 ID 를 가리켜야 한다.
        const refs = signedInfo.References;
        if (!refs || refs.Count !== 1) return false;
        const ref = refs.Item(0);
        if (!ref) return false;
        if (ref.Uri !== `#${rootId}`) return false;

        // 알고리즘 화이트리스트 (DigestMethod).
        const digestMethod = ref.DigestMethod?.Algorithm ?? "";
        if (!ALLOWED_DIGEST_METHODS.has(digestMethod) && !(digestMethod === SHA1_DIGEST_METHOD && sha1Allowed())) {
            return false;
        }

        // XSW 방어 (3): enveloped-signature transform 이 반드시 포함되어야 한다.
        const transforms = ref.Transforms;
        const hasEnveloped = transforms ? transforms.Some((t) => t.Algorithm === ENVELOPED_TRANSFORM) : false;
        if (!hasEnveloped) return false;

        // 서명 검증 — 반드시 신뢰하는 SP 공개키로만. 인자로 키를 넘기면 xmldsigjs 는
        // KeyInfo 를 무시하고 이 키로만 검증한다. 다이제스트 검증(ValidateReferences)에서
        // 중복 ID(XSW wrapper 복제)도 예외로 걸러진다.
        return await signedXml.Verify(publicKey);
    } catch {
        // 파싱 실패·중복 ID 예외·다이제스트 불일치 등 모든 오류는 "검증 실패" = 거부.
        return false;
    }
}
