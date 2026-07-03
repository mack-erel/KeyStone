// vitest 용 $env/dynamic/private 스텁 — 유닛 테스트는 SvelteKit env 를 필요로 하지 않는다.
export const env: Record<string, string | undefined> = {};
