import { defineConfig } from "drizzle-kit";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId =
    (process.env.CLOUDFLARE_IS_PREVIEW === "true"
        ? process.env.CLOUDFLARE_D1_PREVIEW_DATABASE_ID
        : process.env.CLOUDFLARE_D1_DATABASE_ID) ?? "58033cb8-96f7-46f0-bfc2-057e3f903d3c";
const token = process.env.CLOUDFLARE_D1_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;

if (!accountId || !token) {
    throw new Error(
        "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_D1_TOKEN (or CLOUDFLARE_API_TOKEN) must be set for Drizzle D1 HTTP access"
    );
}

export default defineConfig({
    schema: "./src/lib/server/db/schema.ts",
    out: "./drizzle",
    dialect: "sqlite",
    driver: "d1-http",
    dbCredentials: { accountId, databaseId, token },
    verbose: true,
    strict: true,
});
