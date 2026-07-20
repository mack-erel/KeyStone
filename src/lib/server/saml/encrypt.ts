/**
 * SAML 2.0 Assertion 암호화 (XML Encryption, XML-Enc).
 *
 * 서명된 `<saml:Assertion>` 을 `<saml:EncryptedAssertion>` 으로 감싼다:
 *   1. 랜덤 AES-256 세션 키로 assertion 을 AES-256-CBC 암호화
 *      (xmlenc#aes256-cbc — SP 호환성이 가장 넓은 블록 암호).
 *   2. 세션 키를 SP 인증서의 RSA 공개키로 RSA-OAEP-mgf1p(SHA-1) 암호화
 *      (xmlenc#rsa-oaep-mgf1p — 가장 널리 지원되는 키 전송).
 *
 * XML-Enc CBC 규약: CipherValue = base64( IV(16) || ciphertext ).
 * Workers WebCrypto(AES-CBC/RSA-OAEP) 로만 구현하며 외부 라이브러리에 의존하지 않는다.
 *
 * 주의: 산출물의 SP 측 복호화 interop 은 대상 SP 의 XML-Enc 구현에 따라 달라질 수 있으므로
 * 실제 SP 연동 전 반드시 상호운용 테스트를 권장한다. (scripts/verify-saml-encryption.ts 는
 * 자체 라운드트립으로 포맷/크립토 파라미터 정합성만 검증한다.)
 */

import "reflect-metadata";
import { X509Certificate } from "@peculiar/x509";
import { isSpCertTimeValid } from "./cert-validity";

const XENC_NS = "http://www.w3.org/2001/04/xmlenc#";
const DS_NS = "http://www.w3.org/2000/09/xmldsig#";
const ALG_AES256_CBC = "http://www.w3.org/2001/04/xmlenc#aes256-cbc";
const ALG_RSA_OAEP = "http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p";
const ALG_SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1";

function toBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

/**
 * 평문 assertion XML(네임스페이스 자족적이어야 함)을 SP 공개키로 EncryptedAssertion XML 로 감싼다.
 */
export async function encryptSamlAssertion(assertionXml: string, spCertPem: string): Promise<string> {
    // 1. AES-256-CBC 세션 키 + 16바이트 IV.
    const aesKeyRaw = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const aesKey = await crypto.subtle.importKey("raw", aesKeyRaw, { name: "AES-CBC" }, false, ["encrypt"]);
    const plaintext = new TextEncoder().encode(assertionXml);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, aesKey, plaintext));

    // XML-Enc CBC: CipherValue = IV || ciphertext.
    const cbcValue = new Uint8Array(iv.length + ciphertext.length);
    cbcValue.set(iv, 0);
    cbcValue.set(ciphertext, iv.length);

    // 2. SP RSA 공개키로 세션 키를 RSA-OAEP-mgf1p(SHA-1) 암호화.
    const cert = new X509Certificate(spCertPem);
    // ctrls R2: 만료·미유효 SP 인증서로는 암호화하지 않는다(기본 on, IDP_ENFORCE_SP_CERT_VALIDITY=false 로 완화).
    if (!isSpCertTimeValid(cert)) throw new Error("SP 인증서가 유효기간을 벗어났습니다 (notBefore/notAfter).");
    const spki = cert.publicKey.rawData;
    const rsaPub = await crypto.subtle.importKey("spki", spki, { name: "RSA-OAEP", hash: "SHA-1" }, false, ["encrypt"]);
    const encryptedKey = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaPub, aesKeyRaw));

    const encryptedKeyB64 = toBase64(encryptedKey);
    const cipherValueB64 = toBase64(cbcValue);

    return (
        `<saml:EncryptedAssertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">` +
        `<xenc:EncryptedData xmlns:xenc="${XENC_NS}" Type="http://www.w3.org/2001/04/xmlenc#Element">` +
        `<xenc:EncryptionMethod Algorithm="${ALG_AES256_CBC}"/>` +
        `<ds:KeyInfo xmlns:ds="${DS_NS}">` +
        `<xenc:EncryptedKey xmlns:xenc="${XENC_NS}">` +
        `<xenc:EncryptionMethod Algorithm="${ALG_RSA_OAEP}"><ds:DigestMethod Algorithm="${ALG_SHA1}"/></xenc:EncryptionMethod>` +
        `<xenc:CipherData><xenc:CipherValue>${encryptedKeyB64}</xenc:CipherValue></xenc:CipherData>` +
        `</xenc:EncryptedKey>` +
        `</ds:KeyInfo>` +
        `<xenc:CipherData><xenc:CipherValue>${cipherValueB64}</xenc:CipherValue></xenc:CipherData>` +
        `</xenc:EncryptedData>` +
        `</saml:EncryptedAssertion>`
    );
}
