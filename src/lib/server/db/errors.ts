/**
 * DB 방언 무관 에러 분류 헬퍼.
 *
 * drizzle 은 방언별 드라이버의 원본 에러를 그대로 던지므로, unique 제약 위반 여부는
 * 각 드라이버가 노출하는 message/code 문자열의 마커로 판별한다.
 *   - sqlite / d1 / libSQL : "UNIQUE constraint failed" (message)
 *   - postgres             : code "23505" 또는 "duplicate key value" (message)
 *   - mysql                : errno 1062 / code "ER_DUP_ENTRY" / "Duplicate entry" (message)
 */
export function isUniqueViolation(err: unknown): boolean {
    if (err == null) return false;

    const parts: string[] = [];
    if (typeof err === "string") {
        parts.push(err);
    } else if (typeof err === "object") {
        const e = err as { message?: unknown; code?: unknown; cause?: unknown };
        if (typeof e.message === "string") parts.push(e.message);
        if (typeof e.code === "string") parts.push(e.code);
        if (typeof e.code === "number") parts.push(String(e.code));
        // 일부 드라이버는 원본 에러를 cause 로 래핑한다.
        if (e.cause != null && e.cause !== err && isUniqueViolation(e.cause)) return true;
    }

    if (parts.length === 0) return false;
    const haystack = parts.join(" ");
    const upper = haystack.toUpperCase();

    // sqlite / d1
    if (upper.includes("UNIQUE")) return true;
    // postgres
    if (haystack.includes("23505") || upper.includes("DUPLICATE KEY")) return true;
    // mysql
    if (haystack.includes("1062") || upper.includes("ER_DUP_ENTRY") || upper.includes("DUPLICATE ENTRY")) return true;

    return false;
}
