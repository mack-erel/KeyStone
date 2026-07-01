/**
 * DB 스키마 배럴(barrel).
 *
 * 애플리케이션 코드는 항상 이 파일(`$lib/server/db/schema`)에서 테이블/타입을 import 한다.
 * 실제 정의는 활성 방언(`DB_DIALECT`)에 따라 아래 세 파일 중 하나로 해석된다:
 *   - d1       → ./schema.sqlite.ts
 *   - postgres → ./schema.pg.ts
 *   - mysql    → ./schema.mysql.ts
 *
 * `$db-active-schema` alias 는 `svelte.config.js` 에서 `DB_DIALECT` 환경변수에 따라
 * 위 파일 중 하나로 매핑된다(빌드/타입체크 공통). 세 스키마는 컬럼명·테이블명·
 * 인덱스명·JS 추론 타입이 동일하도록 유지되므로, 어떤 방언이 활성이든 쿼리 코드는
 * 그대로 컴파일·동작한다.
 */
export * from "$db-active-schema";
