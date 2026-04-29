import { ldapBind, ldapFetchEntry, ldapSearchDn } from "./client";
import type { LdapProviderConfig, LdapUserAttrs } from "./types";

function escapeLdapChar(ch: string): string {
    return "\\" + ch.charCodeAt(0).toString(16).padStart(2, "0");
}

/** DN 이 base DN 의 suffix 인지(같은 트리에 속하는지) 검증한다. */
function dnIsUnderBase(dn: string, baseDN: string): boolean {
    if (!dn || !baseDN) return false;
    const d = dn.trim().toLowerCase().replace(/\s*,\s*/g, ",");
    const b = baseDN.trim().toLowerCase().replace(/\s*,\s*/g, ",");
    if (d === b) return true;
    return d.endsWith("," + b);
}

function escapeLdapFilter(input: string): string {
    return input
        .split("")
        .map((ch) => {
            const code = ch.charCodeAt(0);
            // RFC 4515 특수문자 + 모든 제어문자(0x00-0x1F, 0x7F)
            if (ch === "\\" || ch === "*" || ch === "(" || ch === ")" || code <= 0x1f || code === 0x7f) {
                return escapeLdapChar(ch);
            }
            return ch;
        })
        .join("");
}

function escapeLdapDn(input: string): string {
    const escaped = input
        .split("")
        .map((ch, idx, arr) => {
            const code = ch.charCodeAt(0);
            // RFC 4514 특수문자 + 제어문자
            if ('\\,+"<>;#='.includes(ch) || code <= 0x1f || code === 0x7f) {
                return escapeLdapChar(ch);
            }
            // leading/trailing space 도 escape
            if (ch === " " && (idx === 0 || idx === arr.length - 1)) {
                return escapeLdapChar(ch);
            }
            return ch;
        })
        .join("");
    return escaped;
}

/**
 * LDAP 인증 + 속성 조회.
 *
 * - bindDN 설정 시: Admin bind → uid 검색으로 DN 확정 → 유저 bind (Search 방식)
 * - bindDN 미설정 시: userDnPattern 으로 DN 조합 → 유저 bind (Pattern 방식)
 *
 * 인증 실패 시 null 반환, 서버 오류는 throw.
 */
export async function authenticateLdap(config: LdapProviderConfig, username: string, password: string): Promise<LdapUserAttrs | null> {
    // 빈 패스워드는 anonymous bind 로 성공 처리되므로 즉시 거부
    if (!password) return null;
    if (!username) return null;

    let userDn: string;

    if (config.bindDN && config.bindPassword) {
        // Search 방식: admin bind → uid 검색으로 실제 DN 확정
        const filter = (config.userSearchFilter ?? "(uid={username})").replaceAll("{username}", escapeLdapFilter(username));
        const found = await ldapSearchDn(config, config.bindDN, config.bindPassword, filter);
        if (!found) return null; // 유저 없음
        // 검색 결과 DN 이 baseDN suffix 인지 검증 (referral/aliasing 우회 방지)
        if (!dnIsUnderBase(found, config.baseDN)) return null;
        userDn = found;
    } else {
        // Pattern 방식: userDnPattern 으로 DN 직접 조합
        if (!config.userDnPattern) return null;
        userDn = config.userDnPattern.replaceAll("{username}", escapeLdapDn(username));
    }

    // 유저 bind — 비밀번호 검증
    try {
        await ldapBind(config, userDn, password);
    } catch {
        return null;
    }

    // 속성 조회
    const attrMap = config.attributeMap ?? {};
    const emailAttr = attrMap.email ?? "mail";
    const displayNameAttr = attrMap.displayName ?? "cn";
    const givenNameAttr = attrMap.givenName ?? "givenName";
    const familyNameAttr = attrMap.familyName ?? "sn";

    let entry: Record<string, string> | null = null;
    try {
        entry = await ldapFetchEntry(config, userDn, password, userDn, [emailAttr, displayNameAttr, givenNameAttr, familyNameAttr]);
    } catch {
        // 속성 조회 실패해도 인증은 성공으로 처리
    }

    return {
        dn: userDn,
        username,
        email: entry?.[emailAttr] || `${username}@ldap.local`,
        displayName: entry?.[displayNameAttr] ?? null,
        givenName: entry?.[givenNameAttr] ?? null,
        familyName: entry?.[familyNameAttr] ?? null,
    };
}
