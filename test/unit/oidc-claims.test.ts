import { describe, it, expect } from "vitest";
import { buildOrganizationClaims, parseOrganizationClaimConfig } from "$lib/server/oidc/claims";
import type { UserMembership } from "$lib/server/org/membership";

/** 클레임 노출 검증용 고정 멤버십(주소속 부서 1 + 팀 1). */
function fixtureMembership(): UserMembership {
    return {
        departments: [
            {
                id: "dept-1",
                name: "플랫폼실",
                code: "PLTF",
                isPrimary: true,
                jobTitle: "리드",
                position: { id: "pos-1", name: "책임", code: "L3", level: 3 },
            },
        ],
        teams: [
            {
                id: "team-1",
                name: "인증팀",
                code: "AUTH",
                departmentName: "플랫폼실",
                isPrimary: true,
                jobTitle: "팀원",
            },
        ],
        parts: [],
        primaryPosition: { id: "pos-1", name: "책임", code: "L3", level: 3 },
        primaryJobTitle: "리드",
    };
}

/** 비어있는 멤버십(소속 없음). */
function emptyMembership(): UserMembership {
    return {
        departments: [],
        teams: [],
        parts: [],
        primaryPosition: null,
        primaryJobTitle: null,
    };
}

describe("buildOrganizationClaims", () => {
    it("config null → 4필드(department/team/position/job_title) 전량 노출", () => {
        const claims = buildOrganizationClaims(fixtureMembership(), null);

        expect(Object.keys(claims).sort()).toEqual(["department", "job_title", "position", "team"]);
        expect(claims.department).toEqual([
            {
                id: "dept-1",
                name: "플랫폼실",
                code: "PLTF",
                is_primary: true,
                job_title: "리드",
                position: { id: "pos-1", name: "책임", code: "L3", level: 3 },
            },
        ]);
        expect(claims.team).toEqual([
            {
                id: "team-1",
                name: "인증팀",
                code: "AUTH",
                department: "플랫폼실",
                is_primary: true,
                job_title: "팀원",
            },
        ]);
        expect(claims.position).toBe("책임");
        expect(claims.job_title).toBe("리드");
    });

    it("config undefined → null 과 동일하게 전량 노출(하위호환)", () => {
        const claims = buildOrganizationClaims(fixtureMembership());
        expect(Object.keys(claims).sort()).toEqual(["department", "job_title", "position", "team"]);
    });

    it("{ team: false } → team 키만 생략, 나머지 3필드 노출", () => {
        const claims = buildOrganizationClaims(fixtureMembership(), { team: false });

        expect("team" in claims).toBe(false);
        expect(Object.keys(claims).sort()).toEqual(["department", "job_title", "position"]);
        expect(claims.department).toHaveLength(1);
        expect(claims.position).toBe("책임");
        expect(claims.job_title).toBe("리드");
    });

    it("{ position: false, jobTitle: false } → 두 최상위 키 생략, department/team 노출", () => {
        const claims = buildOrganizationClaims(fixtureMembership(), { position: false, jobTitle: false });

        expect("position" in claims).toBe(false);
        expect("job_title" in claims).toBe(false);
        expect(Object.keys(claims).sort()).toEqual(["department", "team"]);
        expect(claims.department).toHaveLength(1);
        expect(claims.team).toHaveLength(1);
    });

    it("{ department: false } → department 키만 생략(jobTitle 토글과 job_title 은 독립)", () => {
        const claims = buildOrganizationClaims(fixtureMembership(), { department: false });

        expect("department" in claims).toBe(false);
        expect(Object.keys(claims).sort()).toEqual(["job_title", "position", "team"]);
        // jobTitle 토글은 최상위 job_title 클레임만 제어하며 department.job_title 과 무관.
        expect(claims.job_title).toBe("리드");
    });

    it("전부 false → 조직 클레임 없음(빈 객체)", () => {
        const claims = buildOrganizationClaims(fixtureMembership(), {
            department: false,
            team: false,
            position: false,
            jobTitle: false,
        });

        expect(claims).toEqual({});
        expect(Object.keys(claims)).toHaveLength(0);
    });

    it("true 명시는 노출(false 만 생략을 유발)", () => {
        const claims = buildOrganizationClaims(fixtureMembership(), { team: true, position: false });

        expect("team" in claims).toBe(true);
        expect("position" in claims).toBe(false);
    });

    it("멤버십이 비어있으면 노출 필드는 빈 배열/null 로 그대로 나온다", () => {
        const claims = buildOrganizationClaims(emptyMembership(), null);

        expect(claims.department).toEqual([]);
        expect(claims.team).toEqual([]);
        expect(claims.position).toBeNull();
        expect(claims.job_title).toBeNull();
    });

    it("멤버십이 비어있어도 config off 는 해당 키를 생략한다", () => {
        const claims = buildOrganizationClaims(emptyMembership(), { department: false, team: false });

        expect(Object.keys(claims).sort()).toEqual(["job_title", "position"]);
        expect(claims.position).toBeNull();
        expect(claims.job_title).toBeNull();
    });
});

describe("parseOrganizationClaimConfig", () => {
    it("null/undefined/빈 문자열 → null(전량 노출 폴백)", () => {
        expect(parseOrganizationClaimConfig(null)).toBeNull();
        expect(parseOrganizationClaimConfig(undefined)).toBeNull();
        expect(parseOrganizationClaimConfig("")).toBeNull();
    });

    it("유효 JSON → 알려진 boolean 필드만 취한다", () => {
        expect(parseOrganizationClaimConfig('{"team":false}')).toEqual({ team: false });
        expect(parseOrganizationClaimConfig('{"department":true,"team":false,"position":true,"jobTitle":false}')).toEqual({
            department: true,
            team: false,
            position: true,
            jobTitle: false,
        });
    });

    it("boolean 이 아닌 값/미지 키는 무시한다(오염 방지)", () => {
        expect(parseOrganizationClaimConfig('{"team":"nope","position":1,"jobTitle":false,"evil":true}')).toEqual({
            jobTitle: false,
        });
    });

    it("잘못된 JSON → null(안전 폴백 = 전량 노출)", () => {
        expect(parseOrganizationClaimConfig("{not json}")).toBeNull();
        expect(parseOrganizationClaimConfig("undefined")).toBeNull();
    });

    it("객체가 아닌 유효 JSON(배열/스칼라) → null", () => {
        expect(parseOrganizationClaimConfig("null")).toBeNull();
        expect(parseOrganizationClaimConfig("42")).toBeNull();
        // 배열은 typeof object 이지만 알려진 필드가 없어 빈 config 로 정규화된다.
        expect(parseOrganizationClaimConfig("[1,2,3]")).toEqual({});
    });

    it("파싱 결과를 buildOrganizationClaims 에 넘기면 off 경로가 적용된다(왕복)", () => {
        const config = parseOrganizationClaimConfig('{"position":false,"jobTitle":false}');
        const claims = buildOrganizationClaims(fixtureMembership(), config);

        expect(Object.keys(claims).sort()).toEqual(["department", "team"]);
    });
});
