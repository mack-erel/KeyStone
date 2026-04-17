import { defineConfig } from "drizzle-kit";

// db:generate 는 스키마만 읽으므로 자격증명 불필요.
// db:migrate / db:push 실행 시 드리즐이 자체적으로 검증.
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const databaseId =
    (process.env.CLOUDFLARE_IS_PREVIEW === "true"
        ? process.env.CLOUDFLARE_D1_PREVIEW_DATABASE_ID
        : process.env.CLOUDFLARE_D1_DATABASE_ID) ?? "58033cb8-96f7-46f0-bfc2-057e3f903d3c";
const token = process.env.CLOUDFLARE_D1_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN ?? "";

export default defineConfig({
    schema: "./src/lib/server/db/schema.ts",
    out: "./drizzle",
    dialect: "sqlite",
    driver: "d1-http",
    dbCredentials: { accountId, databaseId, token },
    verbose: true,
    strict: true,
});
