/**
 * admin 서버 액션용 i18n 에러 헬퍼.
 *
 * auth 라우트의 `translate(locals.locale, ...)` 패턴을 admin 액션에도 동일하게 적용한다.
 * 모든 admin 에러 메시지는 i18n 사전의 `admin.errors.*` 네임스페이스에 대칭(ko/en)으로 존재한다.
 */
import { fail } from "@sveltejs/kit";
import type { Locale } from "$lib/i18n/core";
import { translate } from "$lib/i18n/server";

/** admin.errors.<key> 를 현재 로케일로 해석한다. params 는 {{placeholder}} 치환용. */
export function adminError(locale: Locale, key: string, params?: Record<string, string | number>): string {
    return translate(locale, `admin.errors.${key}`, params);
}

/**
 * FormData 에서 필수 id 계열 필드를 파싱한다. 값이 없으면 400 fail(로케일 인지 "잘못된 요청입니다") 반환.
 * admin 라우트 전반에서 12곳+ 반복되던 `if (!id) return fail(400, { error: "잘못된 요청입니다." })` 를 일원화한다.
 *
 * 반환은 판별 유니온: ok=true 면 파싱된 id, ok=false 면 그대로 반환할 fail 결과.
 * extra 로 기존 에러 shape 의 부가 필드(예: { create: true }, { update: true, updateId })를 보존한다.
 */
export function requireFormId(
    fd: FormData,
    locale: Locale,
    opts: { field?: string; extra?: Record<string, unknown> } = {},
): { ok: true; id: string } | { ok: false; failure: ReturnType<typeof fail> } {
    const field = opts.field ?? "id";
    const id = String(fd.get(field) ?? "");
    if (!id) {
        return { ok: false, failure: fail(400, { ...(opts.extra ?? {}), error: adminError(locale, "invalid_request") }) };
    }
    return { ok: true, id };
}
