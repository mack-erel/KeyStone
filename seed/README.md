# Seed migrations

파일명 규칙: NNNN\_설명.sql (4자리 순번)

idempotent SQL만. `_seed_migrations` 테이블로 적용 추적.

실행: `bun run db:seed:migrate` (D1 기본) — `DB_DIALECT` 에 따라 postgres/mysql/sqlite 에도 동일하게 적용된다 (`db:migrate:pg` 등이 자동 호출). SQL 은 모든 방언에서 동작하도록 공통 문법으로 작성할 것.
