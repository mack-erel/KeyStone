import type { LayoutServerLoad } from "./$types";

// hooks.server.ts 에서 결정한 SSR 로케일을 클라이언트로 전달한다.
// +layout.svelte 가 이 값으로 setLocale() 을 렌더 전에 적용해 하이드레이션 미스매치를 방지한다.
export const load: LayoutServerLoad = ({ locals }) => {
    return { locale: locals.locale };
};
