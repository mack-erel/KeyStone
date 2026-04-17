import adapter from "@sveltejs/adapter-cloudflare";

/** @type {import('@sveltejs/kit').Config} */
const config = {
    compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) =>
            filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
    },
    kit: {
        adapter: adapter(),
        // OIDC token endpoint 는 server-to-server 호출이므로 Origin 헤더 없이 전달된다.
        // SvelteKit CSRF 체크는 Origin 헤더가 없을 때 자동으로 통과하므로 별도 설정 불필요.
        // trustedOrigins: ['*'] 는 전체 CSRF 비활성화와 동일하여 제거함.
        typescript: {
            config: (config) => ({
                ...config,
                include: [...config.include, "../drizzle.config.ts"],
            }),
        },
    },
};

export default config;
