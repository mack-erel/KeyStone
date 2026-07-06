import { describe, it, expect } from "vitest";
import {
    teamCreateSchema,
    teamUpdateSchema,
    partCreateSchema,
    positionCreateSchema,
    positionUpdateSchema,
    departmentCreateSchema,
    departmentUpdateSchema,
    optionalText,
    displayOrderField,
} from "$lib/server/admin/schemas";

describe("optionalText (공통 선택 텍스트)", () => {
    it("trim 후 값이 있으면 그대로, 없으면 null", () => {
        expect(optionalText.parse("  BE  ")).toBe("BE");
        expect(optionalText.parse("")).toBeNull();
        expect(optionalText.parse("   ")).toBeNull();
        expect(optionalText.parse(undefined)).toBeNull();
    });
});

describe("displayOrderField (isNaN → 0 보존)", () => {
    it("유효 정수는 coerce, 그 외/빈값은 0", () => {
        expect(displayOrderField.parse("5")).toBe(5);
        expect(displayOrderField.parse("0")).toBe(0);
        expect(displayOrderField.parse("abc")).toBe(0);
        expect(displayOrderField.parse(undefined)).toBe(0);
    });
});

describe("teamCreateSchema", () => {
    it("유효 입력을 정규화 (code/departmentId/description 빈값 → null)", () => {
        const parsed = teamCreateSchema.parse({ name: "  백엔드팀  ", code: "", departmentId: "", description: " 설명 " });
        expect(parsed).toEqual({ name: "백엔드팀", code: null, departmentId: null, description: "설명" });
    });

    it("name 이 비면 실패 + 친화적 메시지", () => {
        const res = teamCreateSchema.safeParse({ name: "   " });
        expect(res.success).toBe(false);
        if (!res.success) expect(res.error.issues[0]?.message).toBe("admin.errors.team_name_required");
    });

    it("departmentId 가 지정되면 trim 값 유지", () => {
        const parsed = teamCreateSchema.parse({ name: "팀", departmentId: " dept-1 " });
        expect(parsed.departmentId).toBe("dept-1");
    });
});

describe("teamUpdateSchema", () => {
    it("id/name 없으면 실패 (잘못된 요청)", () => {
        const res = teamUpdateSchema.safeParse({ name: "팀", status: "active" });
        expect(res.success).toBe(false);
        if (!res.success) expect(res.error.issues[0]?.message).toBe("admin.errors.invalid_request");
    });

    it("status 는 active/inactive 만 허용 (잘못된 enum 거부)", () => {
        expect(teamUpdateSchema.safeParse({ id: "t1", name: "팀", status: "bogus" }).success).toBe(false);
        expect(teamUpdateSchema.safeParse({ id: "t1", name: "팀", status: "inactive" }).success).toBe(true);
    });

    it("status 미지정 시 기본 active", () => {
        const parsed = teamUpdateSchema.parse({ id: "t1", name: "팀" });
        expect(parsed.status).toBe("active");
    });
});

describe("partCreateSchema", () => {
    it("teamId 빈값은 null, name 필수", () => {
        expect(partCreateSchema.parse({ name: "iOS", teamId: "" }).teamId).toBeNull();
        expect(partCreateSchema.safeParse({ name: "" }).success).toBe(false);
    });
});

describe("positionCreateSchema / positionUpdateSchema (level 정수 coerce)", () => {
    it("level 문자열을 숫자로 coerce", () => {
        const parsed = positionCreateSchema.parse({ name: "과장", level: "5" });
        expect(parsed.level).toBe(5);
        expect(typeof parsed.level).toBe("number");
    });

    it("level 이 숫자가 아니면 실패", () => {
        const res = positionCreateSchema.safeParse({ name: "과장", level: "abc" });
        expect(res.success).toBe(false);
        if (!res.success) expect(res.error.issues[0]?.message).toBe("admin.errors.level_must_be_number");
    });

    it("update 도 id/name 필수 + level coerce", () => {
        expect(positionUpdateSchema.parse({ id: "p1", name: "과장", level: "3" }).level).toBe(3);
        expect(positionUpdateSchema.safeParse({ name: "과장", level: "1" }).success).toBe(false);
    });
});

describe("departmentCreateSchema / departmentUpdateSchema", () => {
    it("displayOrder coerce + parentId 빈값 null", () => {
        const parsed = departmentCreateSchema.parse({ name: "개발본부", parentId: "", displayOrder: "2" });
        expect(parsed.displayOrder).toBe(2);
        expect(parsed.parentId).toBeNull();
    });

    it("잘못된 displayOrder 는 0 으로 (기존 동작 보존)", () => {
        expect(departmentCreateSchema.parse({ name: "본부", displayOrder: "xx" }).displayOrder).toBe(0);
    });

    it("update status enum 검증", () => {
        expect(departmentUpdateSchema.safeParse({ id: "d1", name: "본부", status: "active" }).success).toBe(true);
        expect(departmentUpdateSchema.safeParse({ id: "d1", name: "본부", status: "x" }).success).toBe(false);
    });
});
