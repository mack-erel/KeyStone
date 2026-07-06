import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { tenants } from "$lib/server/db/schema";

/**
 * 헬스체크 엔드포인트 (liveness + readiness).
 *
 * hooks.server.ts 는 이 경로에서 auth baseline 조회를 건너뛴다(부하 최소화).
 *
 * - DB 바인딩이 없으면 즉시 503(unavailable).
 * - 바인딩이 있으면 경량 쿼리(tenants LIMIT 1)로 실제 연결 가능 여부까지 확인한다.
 *   쿼리 실패(DB 다운/네트워크 등) 시 503 을 반환해 로드밸런서/오케스트레이터가
 *   해당 인스턴스로 트래픽을 보내지 않게 한다(과거엔 DB 다운에도 항상 200 이었다).
 * - 정상이면 200 { status: "ok", db: "ready" }.
 */
export const GET: RequestHandler = async ({ locals }) => {
    if (!locals.db) {
        return json({ status: "error", db: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }

    try {
        // 경량 readiness 프로브 — 항상 존재하는 tenants 테이블을 한 행만 조회해 연결을 확인한다.
        await locals.db.select({ id: tenants.id }).from(tenants).limit(1);
    } catch {
        return json({ status: "error", db: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }

    return json({ status: "ok", db: "ready" }, { status: 200, headers: { "Cache-Control": "no-store" } });
};
