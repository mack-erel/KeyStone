// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
    namespace App {
        interface Platform {
            // HYPERDRIVE: DB_DIALECT=postgres|mysql 일 때 Postgres/MySQL 연결 문자열을 제공하는
            // Cloudflare Hyperdrive 바인딩 (wrangler 의 hyperdrive 설정으로 주입).
            env: Env & { SKIN_CACHE?: R2Bucket; HYPERDRIVE?: { connectionString: string } };
            ctx: ExecutionContext;
            caches: CacheStorage;
            cf?: IncomingRequestCfProperties;
        }

        // interface Error {}
        interface Locals {
            db?: import("$lib/server/db").DB;
            tenant: import("$lib/server/db/schema").Tenant | null;
            session: import("$lib/server/db/schema").Session | null;
            user: import("$lib/server/db/schema").User | null;
            runtimeConfig: import("$lib/server/auth/runtime").RuntimeConfig;
            runtimeError: string | null;
        }
        // interface PageData {}
        // interface PageState {}
    }
}

export {};
