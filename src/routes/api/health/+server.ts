import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/**
 * 헬스체크 엔드포인트 (liveness + 얕은 readiness).
 *
 * hooks.server.ts 는 이 경로에서 auth baseline 조회를 건너뛴다(부하 최소화).
 * DB 바인딩이 초기화됐는지만 얕게 보고한다. 200 = 프로세스 살아있음.
 */
export const GET: RequestHandler = ({ locals }) => {
    const dbReady = Boolean(locals.db);
    return json(
        {
            status: "ok",
            db: dbReady ? "ready" : "unavailable",
        },
        {
            status: 200,
            headers: { "Cache-Control": "no-store" },
        },
    );
};
