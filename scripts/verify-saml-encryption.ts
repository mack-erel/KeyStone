/**
 * SAML Assertion 암호화 라운드트립 검증 (bun scripts/verify-saml-encryption.ts).
 *
 * encryptSamlAssertion 이 만든 EncryptedAssertion 을 독립적으로 복호화해 원본과
 * 일치하는지 확인한다. 크립토 파라미터(AES-256-CBC IV||CT 레이아웃, RSA-OAEP-mgf1p
 * SHA-1)와 XML 포맷의 자체 정합성을 실증한다.
 *
 * 주의: 이는 자체 라운드트립이며, 실제 SP(예: Shibboleth, ADFS, SimpleSAMLphp)의
 * XML-Enc 복호화기와의 상호운용은 별도 테스트가 필요하다.
 */

import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { encryptSamlAssertion } from "../src/lib/server/saml/encrypt";

x509.cryptoProvider.set(crypto as Crypto);

function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function main() {
    // 1. RSA 키쌍 + 자체서명 인증서 (SP 인증서 역할).
    const alg: RsaHashedKeyGenParams = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
    const keys = (await crypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;

    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "01",
        name: "CN=Test SP",
        notBefore: new Date("2020-01-01T00:00:00Z"),
        notAfter: new Date("2035-01-01T00:00:00Z"),
        signingAlgorithm: alg,
        keys,
    });
    const certPem = cert.toString("pem");

    // 2. 샘플 assertion 을 암호화.
    const sampleAssertion =
        `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a123" Version="2.0" IssueInstant="2026-07-03T00:00:00Z">` +
        `<saml:Issuer>https://idp.example.com</saml:Issuer>` +
        `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">user@example.com</saml:NameID></saml:Subject>` +
        `</saml:Assertion>`;

    const encryptedXml = await encryptSamlAssertion(sampleAssertion, certPem);

    // 3. 독립 복호화: CipherValue 두 개(순서: RSA 암호화 키, AES CBC 값) 추출.
    const cipherValues = [...encryptedXml.matchAll(/<xenc:CipherValue>([^<]+)<\/xenc:CipherValue>/g)].map((m) => m[1]);
    if (cipherValues.length !== 2) throw new Error(`CipherValue 개수 예상 2, 실제 ${cipherValues.length}`);
    const encryptedKey = b64ToBytes(cipherValues[0]);
    const cbcValue = b64ToBytes(cipherValues[1]);

    // 4. RSA-OAEP-mgf1p(SHA-1) 로 AES 키 복호화.
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
    const rsaPriv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSA-OAEP", hash: "SHA-1" }, false, ["decrypt"]);
    const aesKeyRaw = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, rsaPriv, encryptedKey));
    if (aesKeyRaw.length !== 32) throw new Error(`AES 키 길이 예상 32, 실제 ${aesKeyRaw.length}`);

    // 5. AES-256-CBC 복호화 (IV = 앞 16바이트).
    const iv = cbcValue.slice(0, 16);
    const ciphertext = cbcValue.slice(16);
    const aesKey = await crypto.subtle.importKey("raw", aesKeyRaw, { name: "AES-CBC" }, false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, ciphertext));
    const recovered = new TextDecoder().decode(plain);

    // 6. 검증.
    if (recovered !== sampleAssertion) {
        console.error("❌ 라운드트립 불일치");
        console.error("원본  :", sampleAssertion);
        console.error("복호화:", recovered);
        process.exit(1);
    }
    console.log("✅ SAML Assertion 암호화 라운드트립 성공");
    console.log(`   - EncryptedAssertion 길이: ${encryptedXml.length}자`);
    console.log(`   - AES-256-CBC + RSA-OAEP-mgf1p(SHA-1) 복호화 후 원본과 일치`);
}

main().catch((e) => {
    console.error("❌ 검증 실패:", e);
    process.exit(1);
});
