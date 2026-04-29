/**
 * SAML 2.0 Response 빌드 및 Assertion 서명.
 *
 * 핵심 구현 원칙:
 *   1. Response 전체를 하나의 XML 문서로 먼저 조립 (Assertion 포함, 서명 전)
 *   2. Assertion 을 Response 문서 컨텍스트 안에서 서명
 *      → exc-c14n 이 서명 시점과 SP 검증 시점에 동일한 namespace 컨텍스트를 봄
 *   3. Signature 를 Assertion 의 <saml:Issuer> 바로 뒤에 삽입 (SAML 스키마 순서)
 */

import { ensureXmlEngine, xmldsigjs } from "./xml-setup";

function xmlEscape(str: string): string {
    // XML 1.0 에서 허용되지 않는 제어문자(0x00-0x08, 0x0B-0x0C, 0x0E-0x1F) 를 먼저 제거.
    // 이런 문자는 escape 만으로는 valid XML 이 되지 않아 SP 가 파싱 실패하거나 SAML 인젝션 벡터가 된다.
    // eslint-disable-next-line no-control-regex
    const sanitized = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
    return sanitized.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function toIso(d: Date): string {
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function pemToBase64(pem: string): string {
    return pem
        .replace(/-----BEGIN CERTIFICATE-----/, "")
        .replace(/-----END CERTIFICATE-----/, "")
        .replace(/\s+/g, "");
}

export interface BuildSamlResponseParams {
    inResponseTo: string;
    acsUrl: string;
    issuerUrl: string;
    spEntityId: string;
    nameId: string;
    nameIdFormat: string;
    sessionIndex: string;
    attributes: Record<string, string>;
    certPem: string;
    privateKey: CryptoKey;
    /** true 이면 Response 요소도 서명 (Assertion 서명 후 추가 서명) */
    signResponse?: boolean;
    /** AuthnContextClassRef 값 (기본값: PasswordProtectedTransport) */
    authnContextClassRef?: string;
}

export async function buildSignedSamlResponse(params: BuildSamlResponseParams): Promise<string> {
    ensureXmlEngine();

    const now = new Date();
    const responseId = `_r${crypto.randomUUID().replace(/-/g, "")}`;
    const assertionId = `_a${crypto.randomUUID().replace(/-/g, "")}`;
    const issueInstant = toIso(now);
    const notBefore = toIso(new Date(now.getTime() - 30_000));
    const notOnOrAfter = toIso(new Date(now.getTime() + 5 * 60 * 1000));
    const sessionNotOnOrAfter = toIso(new Date(now.getTime() + 8 * 60 * 60 * 1000));
    const certB64 = pemToBase64(params.certPem);

    const attributeStmtXml = Object.keys(params.attributes).length
        ? `<saml:AttributeStatement>` +
          Object.entries(params.attributes)
              .map(
                  ([name, value]) =>
                      `<saml:Attribute Name="${xmlEscape(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">` +
                      `<saml:AttributeValue xsi:type="xs:string">${xmlEscape(value)}</saml:AttributeValue>` +
                      `</saml:Attribute>`,
              )
              .join("") +
          `</saml:AttributeStatement>`
        : "";

    // ── 1. Response 전체를 하나의 XML 문서로 조립 ─────────────────────────────
    // 모든 namespace 를 samlp:Response 루트에 선언.
    // Assertion 은 별도 xmlns 없이 루트에서 상속.
    // 이렇게 하면 exc-c14n 이 Assertion 을 canonical 화할 때 SP 가 동일한
    // namespace 컨텍스트를 보게 된다.
    const fullXml =
        `<samlp:Response` +
        ` xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"` +
        ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
        ` xmlns:xs="http://www.w3.org/2001/XMLSchema"` +
        ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
        ` ID="${responseId}" Version="2.0" IssueInstant="${issueInstant}"` +
        ` InResponseTo="${xmlEscape(params.inResponseTo)}"` +
        ` Destination="${xmlEscape(params.acsUrl)}">` +
        `<saml:Issuer>${xmlEscape(params.issuerUrl)}</saml:Issuer>` +
        `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
        `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant}">` +
        `<saml:Issuer>${xmlEscape(params.issuerUrl)}</saml:Issuer>` +
        `<saml:Subject>` +
        `<saml:NameID Format="${xmlEscape(params.nameIdFormat)}">${xmlEscape(params.nameId)}</saml:NameID>` +
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
        `<saml:SubjectConfirmationData` +
        ` InResponseTo="${xmlEscape(params.inResponseTo)}"` +
        ` NotOnOrAfter="${notOnOrAfter}"` +
        ` Recipient="${xmlEscape(params.acsUrl)}"/>` +
        `</saml:SubjectConfirmation>` +
        `</saml:Subject>` +
        `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
        `<saml:AudienceRestriction>` +
        `<saml:Audience>${xmlEscape(params.spEntityId)}</saml:Audience>` +
        `</saml:AudienceRestriction>` +
        `</saml:Conditions>` +
        `<saml:AuthnStatement` +
        ` AuthnInstant="${issueInstant}"` +
        ` SessionIndex="${xmlEscape(params.sessionIndex)}"` +
        ` SessionNotOnOrAfter="${sessionNotOnOrAfter}">` +
        `<saml:AuthnContext>` +
        `<saml:AuthnContextClassRef>${xmlEscape(params.authnContextClassRef ?? "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport")}</saml:AuthnContextClassRef>` +
        `</saml:AuthnContext>` +
        `</saml:AuthnStatement>` +
        attributeStmtXml +
        `</saml:Assertion>` +
        `</samlp:Response>`;

    // ── 2. DOM 파싱 ───────────────────────────────────────────────────────────
    const responseDoc = xmldsigjs.Parse(fullXml);

    // Assertion 엘리먼트 찾기
    const assertionEls = responseDoc.getElementsByTagNameNS("urn:oasis:names:tc:SAML:2.0:assertion", "Assertion");
    const assertionEl = assertionEls[0] as Element & {
        setIdAttribute?: (name: string, flag: boolean) => void;
    };

    // xmldom 의 getElementById 가 대문자 'ID' 속성을 XML ID 타입으로 인식하도록 등록
    assertionEl.setIdAttribute?.("ID", true);

    // ── 3. Assertion 서명 (Response 문서 컨텍스트 안에서) ─────────────────────
    const signedXml = new xmldsigjs.SignedXml();
    // SignedInfo CanonicalizationMethod 을 exc-c14n 으로 교체 (기본값 standard c14n 은
    // signxml 등 검증기에서 거부되는 경우가 있음)
    signedXml.XmlSignature.SignedInfo.CanonicalizationMethod.Algorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
    await signedXml.Sign({ name: "RSASSA-PKCS1-v1_5" }, params.privateKey, responseDoc, {
        x509: [certB64],
        references: [
            {
                uri: `#${assertionId}`,
                hash: "SHA-256",
                transforms: ["enveloped", "exc-c14n"],
            },
        ],
    });

    // ── 4. Signature 를 Assertion 의 <saml:Issuer> 바로 뒤에 삽입 ────────────
    const sigNode = signedXml.XmlSignature.GetXml();
    if (sigNode) {
        const issuerEls = assertionEl.getElementsByTagNameNS("urn:oasis:names:tc:SAML:2.0:assertion", "Issuer");
        const issuerEl = issuerEls[0];
        if (issuerEl?.nextSibling) {
            assertionEl.insertBefore(sigNode, issuerEl.nextSibling);
        } else {
            assertionEl.appendChild(sigNode);
        }
    }

    // ── 5. Response 서명 (signResponse: true 일 때) ───────────────────────────
    if (params.signResponse) {
        // Response 루트에 ID 속성을 XML ID 타입으로 등록
        const responseEl = responseDoc.documentElement as Element & {
            setIdAttribute?: (name: string, flag: boolean) => void;
        };
        responseEl.setIdAttribute?.("ID", true);

        const signedXmlResponse = new xmldsigjs.SignedXml();
        signedXmlResponse.XmlSignature.SignedInfo.CanonicalizationMethod.Algorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
        await signedXmlResponse.Sign({ name: "RSASSA-PKCS1-v1_5" }, params.privateKey, responseDoc, {
            x509: [certB64],
            references: [
                {
                    uri: `#${responseId}`,
                    hash: "SHA-256",
                    transforms: ["enveloped", "exc-c14n"],
                },
            ],
        });

        const responseSigNode = signedXmlResponse.XmlSignature.GetXml();
        if (responseSigNode) {
            // Response 의 직계 자식 <saml:Issuer> 바로 뒤에 삽입
            const directIssuer = Array.from(responseDoc.documentElement.childNodes).find((n) => n.nodeType === 1 && (n as Element).localName === "Issuer") as Element | undefined;
            if (directIssuer?.nextSibling) {
                responseDoc.documentElement.insertBefore(responseSigNode, directIssuer.nextSibling);
            } else {
                responseDoc.documentElement.appendChild(responseSigNode);
            }
        }
    }

    // ── 6. 직렬화 → base64 (HTTP-POST 바인딩) ────────────────────────────────
    const serialized = xmldsigjs.Stringify(responseDoc).replace(/^<\?xml[^?]*\?>\s*/i, "");

    // TextEncoder 를 통한 안전한 UTF-8 → base64 변환
    const bytes = new TextEncoder().encode(serialized);
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return btoa(binary);
}

export interface BuildSamlErrorResponseParams {
    inResponseTo: string;
    acsUrl: string;
    issuerUrl: string;
    /** 2차 StatusCode (예: urn:oasis:names:tc:SAML:2.0:status:NoPassive) */
    subStatusCode: string;
    certPem: string;
    privateKey: CryptoKey;
}

/**
 * SAML 오류 Response 를 서명하여 base64 인코딩한다.
 * Assertion 없이 Status 만 포함하며, Response 요소를 서명한다.
 */
export async function buildSignedSamlErrorResponse(params: BuildSamlErrorResponseParams): Promise<string> {
    ensureXmlEngine();

    const responseId = `_r${crypto.randomUUID().replace(/-/g, "")}`;
    const issueInstant = toIso(new Date());
    const certB64 = pemToBase64(params.certPem);

    const fullXml =
        `<samlp:Response` +
        ` xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"` +
        ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
        ` ID="${responseId}" Version="2.0" IssueInstant="${issueInstant}"` +
        ` InResponseTo="${xmlEscape(params.inResponseTo)}"` +
        ` Destination="${xmlEscape(params.acsUrl)}">` +
        `<saml:Issuer>${xmlEscape(params.issuerUrl)}</saml:Issuer>` +
        `<samlp:Status>` +
        `<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Responder">` +
        `<samlp:StatusCode Value="${xmlEscape(params.subStatusCode)}"/>` +
        `</samlp:StatusCode>` +
        `</samlp:Status>` +
        `</samlp:Response>`;

    const responseDoc = xmldsigjs.Parse(fullXml);
    const responseEl = responseDoc.documentElement as Element & {
        setIdAttribute?: (name: string, flag: boolean) => void;
    };
    responseEl.setIdAttribute?.("ID", true);

    const signedXml = new xmldsigjs.SignedXml();
    signedXml.XmlSignature.SignedInfo.CanonicalizationMethod.Algorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
    await signedXml.Sign({ name: "RSASSA-PKCS1-v1_5" }, params.privateKey, responseDoc, {
        x509: [certB64],
        references: [{ uri: `#${responseId}`, hash: "SHA-256", transforms: ["enveloped", "exc-c14n"] }],
    });

    const sigNode = signedXml.XmlSignature.GetXml();
    if (sigNode) {
        const issuerEl = Array.from(responseDoc.documentElement.childNodes).find((n) => n.nodeType === 1 && (n as Element).localName === "Issuer") as Element | undefined;
        if (issuerEl?.nextSibling) {
            responseDoc.documentElement.insertBefore(sigNode, issuerEl.nextSibling);
        } else {
            responseDoc.documentElement.appendChild(sigNode);
        }
    }

    const serialized = xmldsigjs.Stringify(responseDoc).replace(/^<\?xml[^?]*\?>\s*/i, "");
    const bytes = new TextEncoder().encode(serialized);
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    return btoa(binary);
}
