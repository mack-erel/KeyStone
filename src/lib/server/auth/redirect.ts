export function sanitizeRedirectTarget(target: string | null | undefined): string | null {
    if (!target) return null;
    let decoded: string;
    try {
        decoded = decodeURIComponent(target);
    } catch {
        return null;
    }
    if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) {
        return null;
    }
    return target;
}
