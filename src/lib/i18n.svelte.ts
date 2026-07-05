import { resolveMessage, type Locale } from "./i18n/core";

export type { Locale };

let currentLocale = $state<Locale>("ko");

export function setLocale(locale: Locale) {
    currentLocale = locale;
}

export function getLocale(): Locale {
    return currentLocale;
}

export function t(key: string, params?: Record<string, string | number>): string {
    // 반응형 $state 로케일을 읽어 core 의 공통 lookup/폴백 로직으로 위임한다.
    return resolveMessage(getLocale(), key, params);
}
