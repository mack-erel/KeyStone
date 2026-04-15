// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties;
		}

		// interface Error {}
		interface Locals {
			db?: import('$lib/server/db').DB;
			tenant: import('$lib/server/db/schema').Tenant | null;
			session: import('$lib/server/db/schema').Session | null;
			user: import('$lib/server/db/schema').User | null;
			runtimeConfig: import('$lib/server/auth/runtime').RuntimeConfig;
			runtimeError: string | null;
		}
		// interface PageData {}
		// interface PageState {}
	}
}

export {};
