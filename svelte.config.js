import adapterCloudflare from "@sveltejs/adapter-cloudflare";
import adapterNode from "@sveltejs/adapter-node";

// 배포 타깃 선택. cloudflare(기본) | node.
// - cloudflare: Cloudflare Workers (D1/Hyperdrive 바인딩 사용 가능)
// - node:       순수 Node 서버 (adapter-node). platform 바인딩 없음 → pg/mysql 은
//               DATABASE_URL, 설정값은 process.env 로 읽는다. D1 은 Workers 전용.
const BUILD_TARGET = process.env.BUILD_TARGET || "cloudflare";
const adapter = BUILD_TARGET === "node" ? adapterNode : adapterCloudflare;

// 활성 DB 방언 선택 (배포 단위). d1(기본) | postgres | mysql.
// `$db-active-schema` alias 를 방언별 스키마 파일로 매핑한다 (빌드/타입체크 공통).
const DB_DIALECT = process.env.DB_DIALECT || "d1";
const SCHEMA_FILE_BY_DIALECT = {
    d1: "schema.sqlite",
    sqlite: "schema.sqlite",
    postgres: "schema.pg",
    mysql: "schema.mysql",
};
const DRIVER_FILE_BY_DIALECT = {
    d1: "driver-d1",
    sqlite: "driver-sqlite",
    postgres: "driver-pg",
    mysql: "driver-mysql",
};
const activeSchemaFile = SCHEMA_FILE_BY_DIALECT[DB_DIALECT] || SCHEMA_FILE_BY_DIALECT.d1;
const activeDriverFile = DRIVER_FILE_BY_DIALECT[DB_DIALECT] || DRIVER_FILE_BY_DIALECT.d1;

/** @type {import('@sveltejs/kit').Config} */
const config = {
    compilerOptions: {
        // Force runes mode for the project, except for libraries. Can be removed in svelte 6.
        runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
    },
    kit: {
        adapter: adapter(),
        alias: {
            // 활성 방언 스키마. src/lib/server/db/schema.ts 배럴이 이 alias 로 재-export 한다.
            "$db-active-schema": `src/lib/server/db/${activeSchemaFile}.ts`,
            // 활성 방언의 정규 DB 타입. src/lib/server/db/index.ts 가 이 alias 로 DB 를 가져온다.
            "$db-active-driver": `src/lib/server/db/${activeDriverFile}.ts`,
        },
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
                // Chrome 은 form-action 을 redirect chain 전체에 적용한다. 'self' 만으로는
                // (1) POST /login → 303 /mfa 같은 동일 origin redirect 가 일부 Chrome 에서 실패하고
                // (2) SAML ACS auto-submit / OIDC RP redirect 처럼 본질적으로 cross-origin 으로 가는
                // 프로토콜 흐름이 차단된다. 'https:' 를 추가해 redirect chain 통과를 보장한다.
                // form-action 의 cross-origin 차단 효과는 약화되지만 origin check / CSRF token /
                // SameSite 쿠키 등 다른 CSRF 보호는 그대로 동작한다. localhost 는 dev 전용.
                "form-action": ["self", "https:", "http://localhost:*"],
                "base-uri": ["self"],
                "object-src": ["none"],
            },
        },
        // SvelteKit 자동 origin 검사는 전역으로 비활성화하고, hooks.server.ts 에서
        // 라우트별로 정밀하게 CSRF 검사를 수행한다 (SAML/OIDC 프로토콜 엔드포인트는
        // 자체 인증으로 보호됨). SvelteKit 6+ 에서 `checkOrigin` 이 deprecated 되어
        // 대신 `trustedOrigins: ['*']` 를 사용한다 — 전역 비활성 의미는 동일.
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
