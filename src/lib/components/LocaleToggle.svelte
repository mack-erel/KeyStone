<script lang="ts">
import { getLocale, type Locale } from "$lib/i18n.svelte";

// src/lib/server/locale.ts 의 LOCALE_COOKIE_NAME 과 동일해야 한다 (server 모듈이라 클라이언트에서 import 불가).
const LOCALE_COOKIE = "idp_locale";
const ONE_YEAR = 60 * 60 * 24 * 365;

const current = $derived(getLocale());

function switchTo(locale: Locale) {
    if (locale === getLocale()) return;
    // 쿠키를 설정하면 다음 SSR(hooks.server.ts)에서 로케일이 반영된다. 리로드로 서버·클라 일관성 확보.
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
    location.reload();
}
</script>

<div class="inline-flex overflow-hidden rounded-md border border-gray-200 bg-white text-xs shadow-sm">
    <button
        type="button"
        onclick={() => switchTo("ko")}
        aria-pressed={current === "ko"}
        class="px-2.5 py-1 font-medium transition {current === 'ko' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50'}">
        한국어
    </button>
    <button
        type="button"
        onclick={() => switchTo("en")}
        aria-pressed={current === "en"}
        class="px-2.5 py-1 font-medium transition {current === 'en' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50'}">
        English
    </button>
</div>
