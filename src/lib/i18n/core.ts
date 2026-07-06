import ko from "./ko.json";
import en from "./en.json";

export type Locale = "ko" | "en";

interface MessageDictionary {
    [key: string]: string | MessageDictionary;
}

type MessageValue = string | MessageDictionary;

export const messages: Record<Locale, MessageDictionary> = {
    ko,
    en,
};

// 현재 로케일에서 키를 찾지 못하면 폴백할 기준 로케일.
export const FALLBACK_LOCALE: Locale = "ko";

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

// {{param}} 형태의 플레이스홀더를 치환한다.
function interpolate(message: string, params?: Record<string, string | number>): string {
    if (!params) {
        return message;
    }

    return message.replace(/{{(.*?)}}/g, (_, param: string) => {
        const trimmedParam = param.trim();
        return params[trimmedParam]?.toString() ?? `{{${trimmedParam}}}`;
    });
}

// 임의의 locale 문자열("en-US"/"ko-KR"/null 등)을 지원 Locale(ko|en)로 정규화한다.
// en* 만 en, 그 외(미상/null 포함)는 ko 기본. 서버 알림/메일에서 수신자 locale 해석에 공유한다.
// 근거: 지원 Locale 은 ko|en 뿐이며, 미상 locale 은 FALLBACK_LOCALE(ko)로 안전하게 수렴시킨다.
export function normalizeLocale(locale: string | null | undefined): Locale {
    return (locale ?? "").toLowerCase().startsWith("en") ? "en" : FALLBACK_LOCALE;
}

// 로케일 + 키 경로를 실제 메시지로 해석한다. 클라이언트 t() 와 서버 translate() 가 공유하는 단일 lookup 진입점.
// 현재 로케일 → ko 폴백 → 원본 key 순으로 해석한다.
export function resolveMessage(locale: Locale, key: string, params?: Record<string, string | number>): string {
    const keys = key.split(".");

    const message = lookup(messages[locale], keys) ?? (locale === FALLBACK_LOCALE ? undefined : lookup(messages[FALLBACK_LOCALE], keys)) ?? key;

    return interpolate(message, params);
}
