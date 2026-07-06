/**
 * 방언 무관 원자적 다중 write 유틸.
 *
 * drizzle 은 방언마다 "여러 문장을 원자적으로 실행"하는 API 가 다르다:
 *   - d1 / sqlite(libSQL): interactive transaction 미지원 → `db.batch([...])`.
 *     빌더 배열을 받아 하나의 batch(트랜잭션)로 실행하며, 중간 문장이 실패하면 전체
 *     rollback 된다(부분 적용 없음).
 *   - postgres / mysql:    interactive transaction → `db.transaction(cb)`.
 *     콜백에서 문장을 순차 await 하며, 콜백이 throw 하면 전체 rollback 된다.
 *
 * `runAtomic` 은 이 차이(배열 vs 콜백)를 흡수한다. 호출부는 executor 를 받아 drizzle
 * write 빌더를 반환하는 op 배열만 넘기면 되고, 두 경로 모두 동일한 원자성·순서 보장을
 * 받는다. 반환값은 각 op 의 실행 결과(예: `.returning()` rows, mysql `affectedRows`)를
 * op 순서대로 담은 배열이다 — 결과가 필요 없는 호출부는 무시하면 된다.
 */

import { type DB, DB_DIALECT } from "$lib/server/db";

/**
 * op 이 받는 실행자. 전체 `db`(batch 경로) 또는 transaction 핸들(transaction 경로)이
 * 전달되며, 둘 다 write 빌더 진입점을 제공한다.
 */
export type AtomicExecutor = Pick<DB, "insert" | "update" | "delete">;

/**
 * 원자 단위로 실행할 단일 write. executor 를 받아 drizzle 빌더를 반환한다.
 * batch 경로에서는 반환된 빌더가 배열로 수집되고, transaction 경로에서는 순차 await 된다.
 */
export type AtomicOp = (h: AtomicExecutor) => unknown;

/**
 * ops 를 활성 방언에 맞는 원자 단위로 실행한다. 결과 배열은 op 순서와 일치한다.
 * 두 경로 모두 중간 실패 시 전체 rollback 되므로 부분 적용이 발생하지 않는다.
 */
export async function runAtomic(db: DB, ops: AtomicOp[]): Promise<unknown[]> {
    if (DB_DIALECT === "d1" || DB_DIALECT === "sqlite") {
        // 정규 DB 타입에 batch 가 노출되지 않는 방언 조합이 있어 캐스팅.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const builders = ops.map((op) => op(db as unknown as AtomicExecutor)) as any[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await (db as any).batch(builders)) as unknown[];
    }
    // postgres / mysql: interactive transaction.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (db as any).transaction(async (tx: AtomicExecutor) => {
        const results: unknown[] = [];
        for (const op of ops) results.push(await op(tx));
        return results;
    })) as unknown[];
}
