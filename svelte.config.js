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
		// Origin 헤더가 없어 SvelteKit 내장 CSRF 체크를 통과하지 못한다. 비활성화.
		// 로그인 폼은 same-origin 이라 origin 이 일치하므로 실질적 보안 수준은 동일.
		csrf: { checkOrigin: false },
		typescript: {
			config: (config) => ({
				...config,
				include: [...config.include, '../drizzle.config.ts']
			})
		}
	}
};

export default config;
