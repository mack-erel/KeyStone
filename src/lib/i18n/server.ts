import { resolveMessage, type Locale } from "./core";

// 서버(SSR/actions)용 번역 헬퍼. 클라이언트 t() 는 $state 기반이라 서버에서 쓸 수 없으므로
// event.locals.locale 을 명시적으로 받아 동일한 lookup/폴백 로직(core.resolveMessage)을 재사용한다.
export function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
    return resolveMessage(locale, key, params);
}
