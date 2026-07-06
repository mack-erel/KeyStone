import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// 서버 라이브러리 순수 함수 유닛 테스트 전용 설정.
// SvelteKit 플러그인 없이 필요한 alias 만 명시 해석한다 ($app/$env 해석 이슈 회피).
const resolvePath = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    define: {
        // vite.config.ts 와 동일하게 활성 방언 리터럴 주입 (기본 d1/sqlite).
        __DB_DIALECT__: JSON.stringify("d1"),
    },
    resolve: {
        alias: {
            $lib: resolvePath("./src/lib"),
            "$db-active-schema": resolvePath("./src/lib/server/db/schema.sqlite.ts"),
            "$db-active-driver": resolvePath("./src/lib/server/db/driver-sqlite.ts"),
            "$env/dynamic/private": resolvePath("./test/stubs/env-dynamic-private.ts"),
            "$env/static/private": resolvePath("./test/stubs/env-dynamic-private.ts"),
        },
    },
    test: {
        environment: "node",
        include: ["test/**/*.test.ts", "src/**/*.test.ts"],
        coverage: {
            // @vitest/coverage-v8 기반. 게이트(threshold)는 강제하지 않고 리포트만 산출한다.
            provider: "v8",
            reporter: ["text", "html"],
            reportsDirectory: "./coverage",
            include: ["src/lib/**/*.ts"],
        },
    },
});
