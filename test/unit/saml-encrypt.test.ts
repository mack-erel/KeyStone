import "reflect-metadata";
import { describe, it, expect, beforeAll } from "vitest";
import * as x509 from "@peculiar/x509";
import { encryptSamlAssertion } from "$lib/server/saml/encrypt";

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

beforeAll(() => {
    x509.cryptoProvider.set(crypto as Crypto);
});

describe("encryptSamlAssertion (A2)", () => {
    it("암호화→독립 복호화 라운드트립이 원본과 일치", async () => {
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

        const assertion =
            `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0" IssueInstant="2026-07-03T00:00:00Z">` +
            `<saml:Issuer>https://idp.example.com</saml:Issuer>` +
            `<saml:Subject><saml:NameID>user@example.com</saml:NameID></saml:Subject>` +
            `</saml:Assertion>`;

        const encryptedXml = await encryptSamlAssertion(assertion, certPem);
        expect(encryptedXml).toContain("<saml:EncryptedAssertion");
        expect(encryptedXml).toContain("aes256-cbc");
        expect(encryptedXml).toContain("rsa-oaep-mgf1p");

        // 독립 복호화.
        const cvs = [...encryptedXml.matchAll(/<xenc:CipherValue>([^<]+)<\/xenc:CipherValue>/g)].map((m) => m[1]);
        expect(cvs).toHaveLength(2);
        const encryptedKey = b64ToBytes(cvs[0]);
        const cbcValue = b64ToBytes(cvs[1]);

        const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
        const rsaPriv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSA-OAEP", hash: "SHA-1" }, false, ["decrypt"]);
        const aesKeyRaw = new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, rsaPriv, encryptedKey));
        expect(aesKeyRaw.length).toBe(32);

        const iv = cbcValue.slice(0, 16);
        const ciphertext = cbcValue.slice(16);
        const aesKey = await crypto.subtle.importKey("raw", aesKeyRaw, { name: "AES-CBC" }, false, ["decrypt"]);
        const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, ciphertext));
        const recovered = new TextDecoder().decode(plain);

        expect(recovered).toBe(assertion);
    });

    it("SP 인증서가 없으면(빈 문자열) 예외", async () => {
        await expect(encryptSamlAssertion("<x/>", "")).rejects.toThrow();
    });
});
