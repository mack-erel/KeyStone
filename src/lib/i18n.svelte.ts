import ko from "./i18n/ko.json";
import en from "./i18n/en.json";

export type Locale = "ko" | "en";

interface MessageDictionary {
    [key: string]: string | MessageDictionary;
}

type MessageValue = string | MessageDictionary;

const messages: Record<Locale, MessageDictionary> = {
    ko,
    en,
};

// 현재 로케일에서 키를 찾지 못하면 폴백할 기준 로케일.
const FALLBACK_LOCALE: Locale = "ko";

let currentLocale = $state<Locale>("ko");

export function setLocale(locale: Locale) {
    currentLocale = locale;
}

export function getLocale(): Locale {
    return currentLocale;
}

// 점(.)으로 구분된 키 경로를 사전에서 조회한다. 문자열이 아니거나 경로가 없으면 undefined.
function lookup(dict: MessageValue, keys: string[]): string | undefined {
    let message: MessageValue = dict;

    for (const currentKey of keys) {
        if (typeof message === "object" && message !== null && currentKey in message) {
            message = message[currentKey];
        } else {
            return undefined;
        }
    }

    return typeof message === "string" ? message : undefined;
}

export function t(key: string, params?: Record<string, string | number>): string {
    const locale = getLocale();
    const keys = key.split(".");

    // 현재 로케일 → ko 폴백 → 원본 key 순으로 해석.
    const message = lookup(messages[locale], keys) ?? (locale === FALLBACK_LOCALE ? undefined : lookup(messages[FALLBACK_LOCALE], keys)) ?? key;

    if (!params) {
        return message;
    }

    return message.replace(/{{(.*?)}}/g, (_, param: string) => {
        const trimmedParam = param.trim();
        return params[trimmedParam]?.toString() ?? `{{${trimmedParam}}}`;
    });
}
