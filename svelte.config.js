import adapter from "@sveltejs/adapter-cloudflare";

/** @type {import('@sveltejs/kit').Config} */
const config = {
    compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
    },
    kit: {
        adapter: adapter(),
        csp: {
            mode: "hash", // unsafe-inline 제거: SvelteKit이 인라인 스크립트 해시를 자동 추가
            directives: {
                "default-src": ["self"],
                "script-src": ["self"], // 해시 자동 추가됨
                "style-src": ["self", "unsafe-inline"], // Tailwind 인라인 스타일 필요
                "img-src": ["self", "data:"],
                "font-src": ["self", "data:"],
                "connect-src": ["self"],
                "frame-ancestors": ["none"],
                "form-action": ["self"], // SAML ACS auto-submit은 raw Response라 SvelteKit CSP 비적용
                "base-uri": ["self"],
                "object-src": ["none"],
            },
        },
        // OIDC/SAML 엔드포인트는 서비스 프로바이더(SP)에서 cross-origin으로 호출하므로
        // SvelteKit CSRF 체크를 비활성화한다. UI 폼의 CSRF는 OIDC state 파라미터가 보호한다.
        csrf: { trustedOrigins: ["*"] },
        typescript: {
            config: (config) => ({
                ...config,
                include: [...config.include, "../drizzle.config.ts"],
            }),
        },
    },
};

export default config;
