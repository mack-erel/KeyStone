/**
 * 활성 DB 방언(dialect) 해석.
 *
 * 배포 단위로 하나의 DB 만 사용한다. 방언은 `DB_DIALECT` 환경변수로 선택하며
 * 빌드 시 `vite.config.ts` 의 `define` 이 `__DB_DIALECT__` 를 리터럴로 치환한다.
 * 이 리터럴 분기 덕분에 워커 번들에는 선택된 드라이버(d1/postgres/mysql)만 포함된다.
 */
export type DbDialect = "d1" | "postgres" | "mysql";

// vite.config.ts 의 define 으로 빌드 시 "d1" | "postgres" | "mysql" 로 치환됨.
// 비-Vite 컨텍스트(bun 스크립트 등)에서는 미정의이므로 typeof 가드로 안전하게 처리.
declare const __DB_DIALECT__: DbDialect | undefined;

function resolveDialect(): DbDialect {
    // 워커 번들: Vite define 으로 치환된 리터럴.
    if (typeof __DB_DIALECT__ !== "undefined" && __DB_DIALECT__) return __DB_DIALECT__;
    // Node/bun 스크립트 fallback.
    const env = typeof process !== "undefined" ? (process.env?.DB_DIALECT as DbDialect | undefined) : undefined;
    return env ?? "d1";
}

export const DB_DIALECT: DbDialect = resolveDialect();
