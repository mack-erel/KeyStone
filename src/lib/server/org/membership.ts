import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "$lib/server/db";
import { departments, parts, positions, teams, userDepartments, userParts, userTeams } from "$lib/server/db/schema";

export interface DepartmentMembership {
    id: string;
    name: string;
    code: string | null;
    isPrimary: boolean;
    jobTitle: string | null;
    position: { id: string; name: string; code: string | null; level: number } | null;
}

export interface TeamMembership {
    id: string;
    name: string;
    code: string | null;
    departmentName: string | null;
    isPrimary: boolean;
    jobTitle: string | null;
}

export interface PartMembership {
    id: string;
    name: string;
    code: string | null;
    teamName: string | null;
    isPrimary: boolean;
    jobTitle: string | null;
}

export interface UserMembership {
    departments: DepartmentMembership[];
    teams: TeamMembership[];
    parts: PartMembership[];
    /** 주소속 부서의 직급 (없으면 null) */
    primaryPosition: { id: string; name: string; code: string | null; level: number } | null;
    /** 주소속 부서의 직책 (없으면 null) */
    primaryJobTitle: string | null;
}

/**
 * 멤버십을 OIDC `groups` scope 용 문자열 배열로 매핑한다.
 * 부서 → 팀 → 파트 순으로, 각 항목은 code 우선(없으면 name)으로 라벨링하고 중복은 제거한다.
 * token 의 id_token 과 userinfo 응답이 동일한 값을 쓰도록 공용화한다.
 */
export function membershipToGroups(membership: UserMembership): string[] {
    const groups: string[] = [];
    const push = (code: string | null, name: string): void => {
        const label = (code && code.trim()) || name;
        if (label) groups.push(label);
    };
    for (const d of membership.departments) push(d.code, d.name);
    for (const t of membership.teams) push(t.code, t.name);
    for (const p of membership.parts) push(p.code, p.name);
    // 순서 유지하며 중복 제거.
    return [...new Set(groups)];
}

/** 현재 소속 중인 부서/팀/파트 소속 정보를 한 번에 조회 */
export async function getUserMembership(db: DB, userId: string): Promise<UserMembership> {
    // 현재 소속 부서 (endedAt IS NULL)
    const deptRows = await db
        .select({
            membershipId: userDepartments.id,
            isPrimary: userDepartments.isPrimary,
            jobTitle: userDepartments.jobTitle,
            deptId: departments.id,
            deptName: departments.name,
            deptCode: departments.code,
            posId: positions.id,
            posName: positions.name,
            posCode: positions.code,
            posLevel: positions.level,
        })
        .from(userDepartments)
        .innerJoin(departments, eq(userDepartments.departmentId, departments.id))
        .leftJoin(positions, eq(userDepartments.positionId, positions.id))
        .where(and(eq(userDepartments.userId, userId), isNull(userDepartments.endedAt)));

    // 현재 소속 팀 (endedAt IS NULL)
    const teamRows = await db
        .select({
            membershipId: userTeams.id,
            isPrimary: userTeams.isPrimary,
            jobTitle: userTeams.jobTitle,
            teamId: teams.id,
            teamName: teams.name,
            teamCode: teams.code,
            deptName: departments.name,
        })
        .from(userTeams)
        .innerJoin(teams, eq(userTeams.teamId, teams.id))
        .leftJoin(departments, eq(teams.departmentId, departments.id))
        .where(and(eq(userTeams.userId, userId), isNull(userTeams.endedAt)));

    const mappedDepts: DepartmentMembership[] = deptRows.map((r) => ({
        id: r.deptId,
        name: r.deptName,
        code: r.deptCode,
        isPrimary: Boolean(r.isPrimary),
        jobTitle: r.jobTitle,
        position: r.posId != null ? { id: r.posId, name: r.posName!, code: r.posCode, level: r.posLevel! } : null,
    }));

    const mappedTeams: TeamMembership[] = teamRows.map((r) => ({
        id: r.teamId,
        name: r.teamName,
        code: r.teamCode,
        departmentName: r.deptName,
        isPrimary: Boolean(r.isPrimary),
        jobTitle: r.jobTitle,
    }));

    // 현재 소속 파트 (endedAt IS NULL)
    const partRows = await db
        .select({
            membershipId: userParts.id,
            isPrimary: userParts.isPrimary,
            jobTitle: userParts.jobTitle,
            partId: parts.id,
            partName: parts.name,
            partCode: parts.code,
            teamName: teams.name,
        })
        .from(userParts)
        .innerJoin(parts, eq(userParts.partId, parts.id))
        .leftJoin(teams, eq(parts.teamId, teams.id))
        .where(and(eq(userParts.userId, userId), isNull(userParts.endedAt)));

    const mappedParts: PartMembership[] = partRows.map((r) => ({
        id: r.partId,
        name: r.partName,
        code: r.partCode,
        teamName: r.teamName,
        isPrimary: Boolean(r.isPrimary),
        jobTitle: r.jobTitle,
    }));

    const primary = mappedDepts.find((d) => d.isPrimary) ?? mappedDepts[0] ?? null;

    return {
        departments: mappedDepts,
        teams: mappedTeams,
        parts: mappedParts,
        primaryPosition: primary?.position ?? null,
        primaryJobTitle: primary?.jobTitle ?? null,
    };
}
