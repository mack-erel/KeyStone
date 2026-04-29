/**
 * 외부 redirect 우회/CRLF 인젝션을 방지한다.
 *
 * - 이중 디코딩: `decodeURIComponent` 를 두 번 반복해도 모두 안전해야 한다.
 * - 제어문자/공백/U+200B 등 unicode 침투 차단.
 * - 절대 URL/프로토콜 상대 URL 거부.
 * - URL 파싱 시 host 가 비어있는 경로형 입력만 허용.
 */
export function sanitizeRedirectTarget(target: string | null | undefined): string | null {
    if (!target) return null;
    if (typeof target !== "string") return null;

    let candidate: string = target;
    // 두 번까지 반복 디코딩하여 어느 단계에서도 외부 URL 패턴이 끼어들지 못하게 한다.
    for (let i = 0; i < 2; i++) {
        let decoded: string;
        try {
            decoded = decodeURIComponent(candidate);
        } catch {
            return null;
        }
        if (!isSafePath(decoded)) return null;
        if (decoded === candidate) break;
        candidate = decoded;
    }

    // URL 파싱: 임시 base 로 해석했을 때 host 가 비어 있어야 한다.
    try {
        const parsed = new URL(target, "http://idp.invalid");
        if (parsed.origin !== "http://idp.invalid") return null;
    } catch {
        return null;
    }

    return target;
}

function isSafePath(value: string): boolean {
    if (!value.startsWith("/")) return false;
    if (value.startsWith("//")) return false;
    if (value.includes("\\")) return false;
    // 제어문자(0x00-0x1F, 0x7F), CR/LF/Tab, U+200B(zero-width space), U+FEFF, NBSP 차단.
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) return false;
        if (code === 0x200b || code === 0xfeff || code === 0x00a0) return false;
        if (code === 0x2028 || code === 0x2029) return false;
    }
    return true;
}
