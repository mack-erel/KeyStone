<script lang="ts">
import "./layout.css";
import favicon from "$lib/assets/favicon.svg";
import { setLocale } from "$lib/i18n.svelte";
import type { LayoutData } from "./$types";

let { children, data }: { children: import("svelte").Snippet; data: LayoutData } = $props();

// SSR·클라이언트 초기 렌더 이전에 서버가 결정한 로케일을 전역 i18n 스토어에 적용해 하이드레이션 미스매치를 방지한다.
// 로케일 변경은 LocaleToggle 의 쿠키 설정 + location.reload()(전체 SSR 재요청)로만 발생하므로
// 클라이언트 네비게이션 중 data.locale 은 불변 — 초기값 적용으로 충분하다.
// svelte-ignore state_referenced_locally
setLocale(data.locale);
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}
