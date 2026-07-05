/**
 * admin 정형 CRUD 라우트(teams/parts/positions/departments)용 zod 폼 스키마.
 *
 * 런타임 폼 검증 표준화 전용 — DB 스키마와는 무관하다.
 * 공통 필드 규칙:
 *   - 필수 텍스트(name): trim 후 빈값이면 실패.
 *   - 선택 텍스트(code/description/FK id): trim 후 빈값이면 null.
 *   - status: "active" | "inactive" (기본 active).
 *   - 정수(level): coerce 후 int. 실패 시 에러.
 *   - displayOrder: coerce 후 int, 실패/빈값이면 0 (기존 isNaN→0 동작 보존).
 */
import { z } from "zod";

/** 필수 텍스트: trim 후 최소 1자. 값 미존재(undefined)/빈값 모두 같은 메시지. */
export const requiredText = (message: string) => z.string(message).trim().min(1, message);

/** 선택 텍스트: 없거나 공백이면 null, 아니면 trim 값. */
export const optionalText = z
    .string()
    .optional()
    .transform((v) => {
        const trimmed = (v ?? "").trim();
        return trimmed.length > 0 ? trimmed : null;
    });

/** status enum (기본 active). */
export const statusField = z.enum(["active", "inactive"]).default("active");

/** 정수 필드(level): 유효하지 않으면 실패. */
export const intField = (message: string) => z.coerce.number(message).int(message);

/** displayOrder: 유효하지 않거나 빈값이면 0 (기존 parseInt isNaN→0 동작 보존). */
export const displayOrderField = z.coerce.number().int().catch(0);

// ── teams ─────────────────────────────────────────────────────────────────
export const teamCreateSchema = z.object({
    name: requiredText("팀명을 입력해 주세요."),
    code: optionalText,
    departmentId: optionalText,
    description: optionalText,
});
export const teamUpdateSchema = z.object({
    id: requiredText("잘못된 요청입니다."),
    name: requiredText("잘못된 요청입니다."),
    code: optionalText,
    departmentId: optionalText,
    description: optionalText,
    status: statusField,
});

// ── parts ─────────────────────────────────────────────────────────────────
export const partCreateSchema = z.object({
    name: requiredText("파트명을 입력해 주세요."),
    code: optionalText,
    teamId: optionalText,
    description: optionalText,
});
export const partUpdateSchema = z.object({
    id: requiredText("잘못된 요청입니다."),
    name: requiredText("잘못된 요청입니다."),
    code: optionalText,
    teamId: optionalText,
    description: optionalText,
    status: statusField,
});

// ── positions ───────────────────────────────────────────────────────────────
export const positionCreateSchema = z.object({
    name: requiredText("직급명을 입력해 주세요."),
    code: optionalText,
    level: intField("레벨은 숫자여야 합니다."),
});
export const positionUpdateSchema = z.object({
    id: requiredText("잘못된 요청입니다."),
    name: requiredText("잘못된 요청입니다."),
    code: optionalText,
    level: intField("레벨은 숫자여야 합니다."),
});

// ── departments ─────────────────────────────────────────────────────────────
export const departmentCreateSchema = z.object({
    name: requiredText("부서명을 입력해 주세요."),
    code: optionalText,
    parentId: optionalText,
    description: optionalText,
    displayOrder: displayOrderField,
});
export const departmentUpdateSchema = z.object({
    id: requiredText("잘못된 요청입니다."),
    name: requiredText("잘못된 요청입니다."),
    code: optionalText,
    parentId: optionalText,
    description: optionalText,
    displayOrder: displayOrderField,
    status: statusField,
});
