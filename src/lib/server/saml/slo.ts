/**
 * SAML 2.0 Single Logout (SLO) helpers.
 *
 * HTTP-Redirect 바인딩 전용 (LogoutRequest / LogoutResponse 생성·파싱·서명).
 *   - Deflate-raw 는 Workers 내장 CompressionStream 사용, 외부 의존성 불필요.
 *   - 서명은 RSASSA-PKCS1-v1_5 / SHA-256 (xmldsig-more#rsa-sha256).
 *   - URL 인코딩은 검증 경로 (verifySamlRedirectSignature) 와 반드시 동일하게 유지.
 */

import "reflect-metadata";
import { DOMParser } from "@xmldom/xmldom";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { DB } from "$lib/server/db";
import { samlSessions, samlSps } from "$lib/server/db/schema";

const MAX_COMPRESSED_BYTES = 8 * 1024;
const MAX_DECOMPRESSED_BYTES = 64 * 1024;

function xmlEscape(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function toIso(d: Date): string {
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function deflateRaw(xml: string): Promise<string> {
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();

    const enc = new TextEncoder();
    writer.write(enc.encode(xml));
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
    const binary = Array.from(buf, (b) => String.fromCharCode(b)).join("");
    return btoa(binary);
}

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

// ── XML 생성 ─────────────────────────────────────────────────────────────────

export interface BuildLogoutRequestParams {
    id: string;
    issuerUrl: string;
    destination: string;
    nameId: string;
    nameIdFormat: string;
    sessionIndex?: string;
}

export function buildSamlLogoutRequest(params: BuildLogoutRequestParams): string {
    const issueInstant = toIso(new Date());
    const sessionIndexXml = params.sessionIndex ? `<samlp:SessionIndex>${xmlEscape(params.sessionIndex)}</samlp:SessionIndex>` : "";
    return (
        `<samlp:LogoutRequest` +
        ` xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"` +
        ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
        ` ID="${xmlEscape(params.id)}" Version="2.0" IssueInstant="${issueInstant}"` +
        ` Destination="${xmlEscape(params.destination)}">` +
        `<saml:Issuer>${xmlEscape(params.issuerUrl)}</saml:Issuer>` +
        `<saml:NameID Format="${xmlEscape(params.nameIdFormat)}">${xmlEscape(params.nameId)}</saml:NameID>` +
        sessionIndexXml +
        `</samlp:LogoutRequest>`
    );
}

export interface BuildLogoutResponseParams {
    id: string;
    inResponseTo: string;
    issuerUrl: string;
    destination: string;
    status: "Success" | "Responder" | "Requester";
}

export function buildSamlLogoutResponse(params: BuildLogoutResponseParams): string {
    const issueInstant = toIso(new Date());
    const statusCode = `urn:oasis:names:tc:SAML:2.0:status:${params.status}`;
    return (
        `<samlp:LogoutResponse` +
        ` xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"` +
        ` xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
        ` ID="${xmlEscape(params.id)}" Version="2.0" IssueInstant="${issueInstant}"` +
        ` InResponseTo="${xmlEscape(params.inResponseTo)}"` +
        ` Destination="${xmlEscape(params.destination)}">` +
        `<saml:Issuer>${xmlEscape(params.issuerUrl)}</saml:Issuer>` +
        `<samlp:Status><samlp:StatusCode Value="${statusCode}"/></samlp:Status>` +
        `</samlp:LogoutResponse>`
    );
}

// ── HTTP-Redirect 서명 ───────────────────────────────────────────────────────

export interface BuildSloRedirectUrlParams {
    /** SP SLO 엔드포인트 (쿼리 파라미터 없는 기본 URL) */
    sloUrl: string;
    /** LogoutRequest 또는 LogoutResponse XML */
    xml: string;
    /** 'SAMLRequest' (IdP-initiated) 또는 'SAMLResponse' (SP-initiated 응답) */
    param: "SAMLRequest" | "SAMLResponse";
    relayState?: string | null;
    privateKey: CryptoKey;
}

/**
 * LogoutRequest 또는 LogoutResponse 를 HTTP-Redirect 바인딩으로 서명한 URL 을 생성한다.
 * URL 인코딩은 verifySamlRedirectSignature 와 반드시 동일해야 하므로 직접 문자열을 조립한다
 * (URLSearchParams 는 사용하지 않는다 — 대소문자·특수문자 인코딩 차이로 서명 검증에 실패할 수 있음).
 */
export async function buildSamlSloRedirectUrl(params: BuildSloRedirectUrlParams): Promise<string> {
    // SLO redirect URL scheme 검증: 외부 SP endpoint 는 반드시 https 여야 한다.
    // javascript:/data:/file: 등의 위험 scheme 은 명시적으로 차단.
    const sloLower = params.sloUrl.toLowerCase().trim();
    if (sloLower.startsWith("javascript:") || sloLower.startsWith("data:") || sloLower.startsWith("file:") || sloLower.startsWith("vbscript:")) {
        throw new Error(`허용되지 않는 SLO URL scheme: ${params.sloUrl}`);
    }
    if (!sloLower.startsWith("https://")) {
        throw new Error(`SLO URL 은 https:// 로 시작해야 합니다: ${params.sloUrl}`);
    }
    const deflated = await deflateRaw(params.xml);
    const sigAlg = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";

    const samlPart = `${params.param}=${encodeURIComponent(deflated)}`;
    const relayPart = params.relayState ? `RelayState=${encodeURIComponent(params.relayState)}` : null;
    const sigAlgPart = `SigAlg=${encodeURIComponent(sigAlg)}`;

    const signedStringParts = [samlPart];
    if (relayPart) signedStringParts.push(relayPart);
    signedStringParts.push(sigAlgPart);
    const signedString = signedStringParts.join("&");

    const enc = new TextEncoder();
    const sigBytes = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, params.privateKey, enc.encode(signedString));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));

    const queryString = `${signedString}&Signature=${encodeURIComponent(sigB64)}`;
    const separator = params.sloUrl.includes("?") ? "&" : "?";
    return `${params.sloUrl}${separator}${queryString}`;
}

// ── 파싱 ─────────────────────────────────────────────────────────────────────

export interface ParsedLogoutRequest {
    id: string;
    issuer: string;
    sessionIndexes: string[];
    nameId: string;
    nameIdFormat: string;
}

export async function parseSamlLogoutRequest(samlRequestB64: string): Promise<ParsedLogoutRequest> {
    const raw = atob(samlRequestB64);
    const binary = new Uint8Array(raw.length) as Uint8Array<ArrayBuffer>;
    for (let i = 0; i < raw.length; i++) binary[i] = raw.charCodeAt(i);
    const xml = await inflateRaw(binary);

    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, "text/xml");
    const root = doc.documentElement;
    if (!root) throw new Error("LogoutRequest XML 파싱 실패: documentElement 없음");

    const id = root.getAttribute("ID") ?? "";

    const issuerEls = doc.getElementsByTagNameNS("urn:oasis:names:tc:SAML:2.0:assertion", "Issuer");
    const issuer = issuerEls[0]?.textContent?.trim() ?? "";

    const nameIdEls = doc.getElementsByTagNameNS("urn:oasis:names:tc:SAML:2.0:assertion", "NameID");
    const nameId = nameIdEls[0]?.textContent?.trim() ?? "";
    const nameIdFormat = nameIdEls[0]?.getAttribute("Format") ?? "";

    const sessionIndexEls = doc.getElementsByTagNameNS("urn:oasis:names:tc:SAML:2.0:protocol", "SessionIndex");
    const sessionIndexes: string[] = [];
    for (let i = 0; i < sessionIndexEls.length; i++) {
        const text = sessionIndexEls[i]?.textContent?.trim();
        if (text) sessionIndexes.push(text);
    }

    return { id, issuer, sessionIndexes, nameId, nameIdFormat };
}

// ── DB ───────────────────────────────────────────────────────────────────────

export interface ActiveSamlSessionRow {
    id: string;
    spId: string;
    sessionIndex: string;
    nameId: string;
    nameIdFormat: string | null;
    sp: {
        sloUrl: string | null;
        sloBinding: string | null;
        entityId: string;
        cert: string | null;
    };
}

/**
 * 주어진 IdP 세션(sessions.id) 에 묶여 있으면서 endedAt 이 NULL 인 SAML 세션 목록.
 */
export async function getActiveSamlSessionsForSession(db: DB, sessionId: string): Promise<ActiveSamlSessionRow[]> {
    const rows = await db
        .select({
            id: samlSessions.id,
            spId: samlSessions.spId,
            sessionIndex: samlSessions.sessionIndex,
            nameId: samlSessions.nameId,
            nameIdFormat: samlSessions.nameIdFormat,
            sloUrl: samlSps.sloUrl,
            sloBinding: samlSps.sloBinding,
            entityId: samlSps.entityId,
            cert: samlSps.cert,
        })
        .from(samlSessions)
        .innerJoin(samlSps, eq(samlSessions.spId, samlSps.id))
        .where(and(eq(samlSessions.sessionId, sessionId), isNull(samlSessions.endedAt)));

    return rows.map((r) => ({
        id: r.id,
        spId: r.spId,
        sessionIndex: r.sessionIndex,
        nameId: r.nameId,
        nameIdFormat: r.nameIdFormat,
        sp: {
            sloUrl: r.sloUrl,
            sloBinding: r.sloBinding,
            entityId: r.entityId,
            cert: r.cert,
        },
    }));
}

/**
 * SLO 체인 진행 중 samlSloStates.pendingSpDataJson 에 직렬화되는 SP 단위 데이터.
 */
export interface PendingSpData {
    spId: string;
    entityId: string;
    sloUrl: string;
    nameId: string;
    nameIdFormat: string;
    sessionIndex: string;
}

/**
 * 주어진 IdP 세션에 묶여 있으면서 HTTP-Redirect SLO 가 가능한 (sloUrl 이 있는) 활성 SAML 세션을
 * PendingSpData[] 로 수집한다. excludeSpEntityId 가 주어지면 해당 SP 는 제외한다 (예: SP-initiated
 * SLO 에서 최초 요청자 SP 를 체인에서 빼고 싶을 때).
 */
export async function collectPendingSpData(db: DB, sessionId: string, excludeSpEntityId?: string): Promise<PendingSpData[]> {
    const baseCond = and(eq(samlSessions.sessionId, sessionId), isNull(samlSessions.endedAt));
    const whereCond = excludeSpEntityId ? and(baseCond, ne(samlSps.entityId, excludeSpEntityId)) : baseCond;

    const rows = await db
        .select({
            spId: samlSessions.spId,
            sessionIndex: samlSessions.sessionIndex,
            nameId: samlSessions.nameId,
            nameIdFormat: samlSessions.nameIdFormat,
            entityId: samlSps.entityId,
            sloUrl: samlSps.sloUrl,
        })
        .from(samlSessions)
        .innerJoin(samlSps, eq(samlSessions.spId, samlSps.id))
        .where(whereCond);

    const result: PendingSpData[] = [];
    for (const r of rows) {
        if (!r.sloUrl) continue;
        result.push({
            spId: r.spId,
            entityId: r.entityId,
            sloUrl: r.sloUrl,
            nameId: r.nameId,
            nameIdFormat: r.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
            sessionIndex: r.sessionIndex,
        });
    }
    return result;
}
