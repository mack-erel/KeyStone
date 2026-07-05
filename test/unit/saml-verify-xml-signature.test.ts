import "reflect-metadata";
import { describe, it, expect, beforeAll } from "vitest";
import * as x509 from "@peculiar/x509";
import { ensureXmlEngine, xmldsigjs } from "$lib/server/saml/xml-setup";
import { verifyEnvelopedXmlSignature } from "$lib/server/saml/verify-xml-signature";

const RSA_ALG: RsaHashedKeyGenParams = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
};

interface KeyCert {
    keys: CryptoKeyPair;
    certPem: string;
    certB64: string;
}

async function makeKeyCert(cn: string): Promise<KeyCert> {
    const keys = (await crypto.subtle.generateKey(RSA_ALG, true, ["sign", "verify"])) as CryptoKeyPair;
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name: `CN=${cn}`,
        notBefore: new Date("2020-01-01T00:00:00Z"),
        notAfter: new Date("2035-01-01T00:00:00Z"),
        signingAlgorithm: RSA_ALG,
        keys,
    });
    const certPem = cert.toString("pem");
    const certB64 = certPem
        .replace(/-----BEGIN CERTIFICATE-----/, "")
        .replace(/-----END CERTIFICATE-----/, "")
        .replace(/\s+/g, "");
    return { keys, certPem, certB64 };
}

/**
 * 테스트용 AuthnRequest 를 enveloped ds:Signature 로 서명한다 (response.ts 서명 생성과 동일 방식).
 * Signature 는 <saml:Issuer> 바로 뒤(문서 루트의 직계 자식)에 삽입한다.
 */
async function signAuthnRequest(id: string, kc: KeyCert): Promise<string> {
    ensureXmlEngine();
    const issueInstant = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const fullXml =
        `<samlp:AuthnRequest` +
        ` xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"` +
        ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
        ` ID="${id}" Version="2.0" IssueInstant="${issueInstant}"` +
        ` Destination="https://idp.example.com/saml/sso"` +
        ` AssertionConsumerServiceURL="https://sp.example.com/acs">` +
        `<saml:Issuer>https://sp.example.com</saml:Issuer>` +
        `</samlp:AuthnRequest>`;

    const doc = xmldsigjs.Parse(fullXml);
    const rootEl = doc.documentElement as Element & { setIdAttribute?: (name: string, flag: boolean) => void };
    rootEl.setIdAttribute?.("ID", true);

    const signedXml = new xmldsigjs.SignedXml();
    signedXml.XmlSignature.SignedInfo.CanonicalizationMethod.Algorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
    await signedXml.Sign({ name: "RSASSA-PKCS1-v1_5" }, kc.keys.privateKey, doc, {
        x509: [kc.certB64],
        references: [{ uri: `#${id}`, hash: "SHA-256", transforms: ["enveloped", "exc-c14n"] }],
    });

    const sigNode = signedXml.XmlSignature.GetXml();
    if (sigNode) {
        const issuerEls = rootEl.getElementsByTagNameNS("urn:oasis:names:tc:SAML:2.0:assertion", "Issuer");
        const issuerEl = issuerEls[0];
        if (issuerEl?.nextSibling) {
            rootEl.insertBefore(sigNode, issuerEl.nextSibling);
        } else {
            rootEl.appendChild(sigNode);
        }
    }
    return xmldsigjs.Stringify(doc).replace(/^<\?xml[^?]*\?>\s*/i, "");
}

beforeAll(() => {
    x509.cryptoProvider.set(crypto as Crypto);
});

describe("verifyEnvelopedXmlSignature", () => {
    it("SP 인증서 개인키로 서명한 AuthnRequest 는 통과한다", async () => {
        const sp = await makeKeyCert("Test SP");
        const xml = await signAuthnRequest("_authnreq_ok", sp);
        expect(await verifyEnvelopedXmlSignature(xml, sp.certPem)).toBe(true);
    });

    it("다른 키로 서명하면 실패한다 (KeyInfo 인증서가 아니라 신뢰 SP 인증서로만 검증)", async () => {
        const signer = await makeKeyCert("Attacker SP");
        const trusted = await makeKeyCert("Trusted SP");
        // XML 은 attacker 키로 서명되고 KeyInfo 에도 attacker 인증서가 들어있지만,
        // 검증은 trusted 인증서 공개키로만 한다 → 실패해야 한다.
        const xml = await signAuthnRequest("_authnreq_wrongkey", signer);
        expect(await verifyEnvelopedXmlSignature(xml, trusted.certPem)).toBe(false);
    });

    it("서명 후 본문(콘텐츠)을 변조하면 실패한다", async () => {
        const sp = await makeKeyCert("Test SP");
        const xml = await signAuthnRequest("_authnreq_tamperbody", sp);
        // Issuer 값을 변조 → 다이제스트 불일치.
        const tampered = xml.replace("https://sp.example.com</saml:Issuer>", "https://evil.example.com</saml:Issuer>");
        expect(tampered).not.toBe(xml);
        expect(await verifyEnvelopedXmlSignature(tampered, sp.certPem)).toBe(false);
    });

    it("SignatureValue 를 변조하면 실패한다", async () => {
        const sp = await makeKeyCert("Test SP");
        const xml = await signAuthnRequest("_authnreq_tampersig", sp);
        const m = xml.match(/<(?:\w+:)?SignatureValue[^>]*>([^<]+)</);
        expect(m).not.toBeNull();
        const original = m![1];
        // base64 문자열의 첫 글자를 뒤집어 서명값을 깨뜨린다.
        const flipped = (original[0] === "A" ? "B" : "A") + original.slice(1);
        const tampered = xml.replace(original, flipped);
        expect(tampered).not.toBe(xml);
        expect(await verifyEnvelopedXmlSignature(tampered, sp.certPem)).toBe(false);
    });

    it("서명이 없는 AuthnRequest 는 실패한다 (검증할 서명 없음)", async () => {
        const sp = await makeKeyCert("Test SP");
        const unsigned =
            `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"` +
            ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_nosig" Version="2.0"` +
            ` IssueInstant="2026-07-05T00:00:00Z"><saml:Issuer>https://sp.example.com</saml:Issuer></samlp:AuthnRequest>`;
        expect(await verifyEnvelopedXmlSignature(unsigned, sp.certPem)).toBe(false);
    });

    it("XSW: 서명된 요청을 다른 루트로 감싸면 실패한다 (참조 URI ≠ 문서 루트)", async () => {
        const sp = await makeKeyCert("Test SP");
        const inner = await signAuthnRequest("_authnreq_inner", sp);
        // inner(서명 포함)를 XML 선언 제거 후 악성 루트의 자식으로 감싼다.
        const innerBody = inner.replace(/^<\?xml[^?]*\?>\s*/i, "");
        const wrapped =
            `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"` +
            ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_evilroot" Version="2.0"` +
            ` IssueInstant="2026-07-05T00:00:00Z" AssertionConsumerServiceURL="https://evil.example.com/acs">` +
            `<saml:Issuer>https://sp.example.com</saml:Issuer>` +
            `<samlp:Extensions>${innerBody}</samlp:Extensions>` +
            `</samlp:AuthnRequest>`;
        // 악성 루트 ID(_evilroot)와 서명 참조 URI(#_authnreq_inner) 불일치 + Signature parent≠root → 거부.
        expect(await verifyEnvelopedXmlSignature(wrapped, sp.certPem)).toBe(false);
    });

    it("XSW: 동일 ID 로 서명 요소를 복제하면 실패한다 (중복 ID)", async () => {
        const sp = await makeKeyCert("Test SP");
        const inner = await signAuthnRequest("_dupid", sp);
        const innerBody = inner.replace(/^<\?xml[^?]*\?>\s*/i, "");
        // 루트도 _dupid, 자식으로도 원본 서명요소(_dupid)를 심는다 → 중복 ID.
        const wrapped =
            `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"` +
            ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_dupid" Version="2.0"` +
            ` IssueInstant="2026-07-05T00:00:00Z"><saml:Issuer>https://sp.example.com</saml:Issuer>` +
            `<samlp:Extensions>${innerBody}</samlp:Extensions></samlp:AuthnRequest>`;
        expect(await verifyEnvelopedXmlSignature(wrapped, sp.certPem)).toBe(false);
    });

    it("빈 인증서(certPem)이면 실패한다", async () => {
        const sp = await makeKeyCert("Test SP");
        const xml = await signAuthnRequest("_emptycert", sp);
        expect(await verifyEnvelopedXmlSignature(xml, "")).toBe(false);
    });
});
