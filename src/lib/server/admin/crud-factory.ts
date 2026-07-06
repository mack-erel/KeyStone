/**
 * admin 정형 CRUD 팩토리.
 *
 * teams/parts/positions/departments 처럼 "tenant 스코프 단일 테이블 + 생성/수정/삭제 시
 * audit 기록" 이라는 동일 골격을 공유하는 라우트를 하나의 팩토리로 통합한다.
 *
 * 기존 계약(회귀 금지):
 *   - create 실패 → fail(400, { create: true, error })
 *   - update/delete 실패 → fail(400, { error })
 *   - audit kind → `${auditPrefix}_created | _updated | _deleted`
 *   - 모든 쓰기는 tenant 스코프: and(eq(id), eq(tenantId, tenant.id))
 *
 * 폼 검증은 zod 스키마(런타임 검증)로 표준화한다 — 스키마 변경은 유발하지 않는다.
 */
import { fail, type RequestEvent } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import type { z } from "zod";
import { requireAdminContext } from "$lib/server/auth/guards";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import { translate } from "$lib/i18n/server";
import type { DB } from "$lib/server/db";

type AdminContext = ReturnType<typeof requireAdminContext>;
type Tenant = AdminContext["tenant"];

/** 훅/커스텀 load 에 넘겨지는 tenant 스코프 컨텍스트. */
export interface CrudContext {
    db: DB;
    tenant: Tenant;
}

/**
 * 팩토리가 조작할 테이블. 활성 방언(DB_DIALECT)의 drizzle 테이블 타입을 그대로 따른다 —
 * db.insert 의 인자 타입에서 유도해 pg/mysql/sqlite 어느 방언이 활성이든 db.insert/update/
 * delete 와 정확히 호환된다(3방언 스키마는 컬럼/인덱스/추론 타입이 동일하게 유지됨).
 * tenant 스코프/식별에 쓰는 id·tenantId 컬럼을 노출한다.
 */
type ActiveTable = Parameters<DB["insert"]>[0];
type CrudTable = ActiveTable & { id: Column; tenantId: Column };

/**
 * 훅 반환값 계약: 문제가 있으면 사용자에게 보여줄 에러 메시지(string)를, 통과면 null.
 * beforeCreate/beforeUpdate 는 FK 참조 무결성 등 zod 로 표현 불가한 검증에 쓴다.
 */
export type CrudHook<TValues> = (ctx: CrudContext, values: TValues) => Promise<string | null> | string | null;

export interface AdminCrudConfig<TCreateSchema extends z.ZodTypeAny, TUpdateSchema extends z.ZodTypeAny, TLoadData extends Record<string, unknown>> {
    /** drizzle 테이블 (id, tenantId 컬럼 보유). */
    table: CrudTable;
    /** audit kind 접두사: "team" | "part" | "position" | "department". */
    auditPrefix: string;
    /** 생성 폼 검증 스키마. 출력 객체가 곧 insert 컬럼(tenantId 제외). */
    createSchema: TCreateSchema;
    /** 수정 폼 검증 스키마. 반드시 `id` 를 포함해야 한다. */
    updateSchema: TUpdateSchema;
    /** 라우트별 load — 조인/셀렉터는 여기서 처리한다. */
    load: (ctx: CrudContext) => Promise<TLoadData>;
    /** 생성 전 추가 검증(FK 참조 등). 실패 시 에러 메시지 반환. */
    beforeCreate?: CrudHook<z.infer<TCreateSchema>>;
    /** 수정 전 추가 검증(FK 참조/계층 등). 실패 시 에러 메시지 반환. */
    beforeUpdate?: CrudHook<z.infer<TUpdateSchema>>;
    /** audit detail(create). 미지정 시 검증된 값 전체. */
    buildCreateDetail?: (values: z.infer<TCreateSchema>) => Record<string, unknown>;
    /** audit detail(update). 미지정 시 { id, ...나머지 값 }. */
    buildUpdateDetail?: (id: string, values: Record<string, unknown>) => Record<string, unknown>;
}

/** FormData → 평범한 문자열 레코드. File 값은 무시(해당 폼엔 파일 없음). */
function formDataToRecord(fd: FormData): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const [key, value] of fd.entries()) {
        if (typeof value === "string") obj[key] = value;
    }
    return obj;
}

/**
 * zod 검증 실패 시 첫 이슈 메시지를 현재 로케일로 해석한다.
 * 스키마 메시지는 i18n 키(admin.errors.*)로 담겨 있으므로 translate 로 표시 문자열을 만든다.
 * 키가 아닌 zod 기본 메시지(enum 등)는 translate 폴백이 원문을 그대로 반환한다.
 */
function firstIssue(error: z.ZodError, locale: App.Locals["locale"]): string {
    return translate(locale, error.issues[0]?.message ?? "admin.errors.invalid_request");
}

/**
 * 설정을 받아 SvelteKit `load` 와 `actions`(create/update/delete)를 생성한다.
 */
export function createAdminCrudRoute<TCreateSchema extends z.ZodTypeAny, TUpdateSchema extends z.ZodTypeAny, TLoadData extends Record<string, unknown>>(
    config: AdminCrudConfig<TCreateSchema, TUpdateSchema, TLoadData>,
) {
    const load = async (event: { locals: App.Locals }): Promise<TLoadData> => {
        const { db, tenant } = requireAdminContext(event.locals);
        return config.load({ db, tenant });
    };

    const create = async (event: RequestEvent) => {
        const { db, tenant, user } = requireAdminContext(event.locals);
        const fd = await event.request.formData();

        const parsed = config.createSchema.safeParse(formDataToRecord(fd));
        if (!parsed.success) {
            return fail(400, { create: true, error: firstIssue(parsed.error, event.locals.locale) });
        }
        const values = parsed.data as z.infer<TCreateSchema>;

        if (config.beforeCreate) {
            const hookError = await config.beforeCreate({ db, tenant }, values);
            if (hookError) return fail(400, { create: true, error: hookError });
        }

        await db.insert(config.table).values({ tenantId: tenant.id, ...(values as Record<string, unknown>) } as typeof config.table.$inferInsert);

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: user.id,
            kind: `${config.auditPrefix}_created`,
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: config.buildCreateDetail ? config.buildCreateDetail(values) : (values as Record<string, unknown>),
        });
        return { created: true };
    };

    const update = async (event: RequestEvent) => {
        const { db, tenant, user } = requireAdminContext(event.locals);
        const fd = await event.request.formData();

        const parsed = config.updateSchema.safeParse(formDataToRecord(fd));
        if (!parsed.success) {
            return fail(400, { error: firstIssue(parsed.error, event.locals.locale) });
        }
        const data = parsed.data as z.infer<TUpdateSchema>;

        if (config.beforeUpdate) {
            const hookError = await config.beforeUpdate({ db, tenant }, data);
            if (hookError) return fail(400, { error: hookError });
        }

        const { id, ...rest } = data as { id: string } & Record<string, unknown>;

        await db
            .update(config.table)
            .set({ ...rest, updatedAt: new Date() } as Partial<typeof config.table.$inferInsert>)
            .where(and(eq(config.table.id, id), eq(config.table.tenantId, tenant.id)));

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: user.id,
            kind: `${config.auditPrefix}_updated`,
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: config.buildUpdateDetail ? config.buildUpdateDetail(id, rest) : { id, ...rest },
        });
        return { updated: true };
    };

    const del = async (event: RequestEvent) => {
        const { db, tenant, user } = requireAdminContext(event.locals);
        const fd = await event.request.formData();
        const id = String(fd.get("id") ?? "");
        if (!id) return fail(400, { error: translate(event.locals.locale, "admin.errors.invalid_request") });

        await db.delete(config.table).where(and(eq(config.table.id, id), eq(config.table.tenantId, tenant.id)));

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: user.id,
            kind: `${config.auditPrefix}_deleted`,
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { id },
        });
        return { deleted: true };
    };

    return { load, actions: { create, update, delete: del } };
}
