import type { Locale } from "$lib/i18n.svelte";

// 로케일 선택을 저장하는 쿠키 이름. LocaleToggle 및 SSR 로케일 결정에서 공유한다.
export const LOCALE_COOKIE_NAME = "idp_locale";

// 기본 로케일 — 쿠키/Accept-Language 로 결정하지 못했을 때 사용.
export const DEFAULT_LOCALE: Locale = "ko";

function isSupported(value: string | undefined | null): value is Locale {
    return value === "ko" || value === "en";
}

// Accept-Language 헤더("en-US,en;q=0.9,ko;q=0.8")를 q-value 순으로 파싱해 지원 로케일 중 최우선을 반환.
function parseAcceptLanguage(header: string | null): Locale | null {
    if (!header) return null;

    const ranked = header
        .split(",")
        .map((part) => {
            const [tag, ...params] = part.trim().split(";");
            const qParam = params.find((p) => p.trim().startsWith("q="));
            const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;
            return { tag: tag.trim().toLowerCase(), q: Number.isNaN(q) ? 0 : q };
        })
        .filter((entry) => entry.tag.length > 0)
        .sort((a, b) => b.q - a.q);

    for (const { tag } of ranked) {
        const primary = tag.split("-")[0];
        if (isSupported(primary)) return primary;
    }

    return null;
}

// 쿠키(idp_locale) → Accept-Language 헤더 → 기본 로케일 순으로 SSR 로케일을 결정한다.
export function resolveLocale(cookieValue: string | undefined, acceptLanguage: string | null): Locale {
    if (isSupported(cookieValue)) return cookieValue;
    return parseAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}
