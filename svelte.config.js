import adapter from '@sveltejs/adapter-cloudflare';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		// OIDC token endpoint 는 외부 서버(Cloudflare Access 등)가 서버-서버로 호출하므로
		// Origin 헤더가 없어 SvelteKit 내장 CSRF 체크를 통과하지 못한다.
		// trustedOrigins: ['*'] 는 checkOrigin: false 와 동일한 효과 (공식 마이그레이션 권장).
		csrf: { trustedOrigins: ['*'] },
		typescript: {
			config: (config) => ({
				...config,
				include: [...config.include, '../drizzle.config.ts']
			})
		}
	}
};

export default config;
