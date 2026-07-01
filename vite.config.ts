import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// 활성 DB 방언 (배포 단위). d1(기본) | postgres | mysql.
// __DB_DIALECT__ 를 리터럴로 치환해, 워커 번들에 선택된 드라이버만 포함되도록 한다
// (src/lib/server/db/index.ts 의 리터럴 분기가 esbuild DCE 대상이 됨).
const DB_DIALECT = process.env.DB_DIALECT || "d1";

export default defineConfig({
    plugins: [tailwindcss(), sveltekit()],
    define: {
        __DB_DIALECT__: JSON.stringify(DB_DIALECT),
    },
});
