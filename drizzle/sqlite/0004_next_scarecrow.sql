DROP INDEX `oidc_grants_code_uidx`;--> statement-breakpoint
ALTER TABLE `oidc_grants` DROP COLUMN `code`;--> statement-breakpoint
-- [manual] client_skins.created_at 초 단위(legacy timestamp) → ms 단위(timestamp_ms) 보정.
-- 스키마상 컬럼 타입은 integer 로 동일해 drizzle-kit 가 DDL diff 를 만들지 못하므로 수동 추가.
-- ms 값은 ~1.7e12, 초 값은 ~1.7e9 이므로 1e11 미만 행만 초 단위로 판별해 ×1000 (재적용 안전).
UPDATE `client_skins` SET `created_at` = `created_at` * 1000 WHERE `created_at` < 100000000000;