import { defineConfig } from "drizzle-kit";

// db:generate 는 스키마만 읽으므로 자격증명 불필요.
// db:migrate / db:push 실행 시 드리즐이 자체적으로 검증.
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const isPreview = process.env.CLOUDFLARE_IS_PREVIEW === "true";
const databaseId = isPreview ? process.env.CLOUDFLARE_D1_PREVIEW_DATABASE_ID : process.env.CLOUDFLARE_D1_DATABASE_ID;
const token = process.env.CLOUDFLARE_D1_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN ?? "";

// 하드코딩 fallback 제거 — 미설정 시 phantom DB 에 마이그레이션이 적용되는 사고를 방지.
// (db:generate 는 자격증명 없이 동작하므로 빈 값 허용. db:migrate 는 dbCredentials 검증에서 실패한다.)

export default defineConfig({
    schema: "./src/lib/server/db/schema.ts",
    out: "./drizzle",
    dialect: "sqlite",
    driver: "d1-http",
    dbCredentials: { accountId, databaseId: databaseId ?? "", token },
    verbose: true,
    strict: true,
});
