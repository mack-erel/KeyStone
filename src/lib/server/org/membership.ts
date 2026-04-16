import { and, eq, isNull } from 'drizzle-orm';
import type { DB } from '$lib/server/db';
import {
	departments,
	positions,
	teams,
	userDepartments,
	userTeams
} from '$lib/server/db/schema';

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

export interface UserMembership {
	departments: DepartmentMembership[];
	teams: TeamMembership[];
	/** 주소속 부서의 직급 (없으면 null) */
	primaryPosition: { id: string; name: string; code: string | null; level: number } | null;
	/** 주소속 부서의 직책 (없으면 null) */
	primaryJobTitle: string | null;
}

/** 현재 소속 중인 부서/팀 소속 정보를 한 번에 조회 */
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
			posLevel: positions.level
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
			deptName: departments.name
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
		position:
			r.posId != null
				? { id: r.posId, name: r.posName!, code: r.posCode, level: r.posLevel! }
				: null
	}));

	const mappedTeams: TeamMembership[] = teamRows.map((r) => ({
		id: r.teamId,
		name: r.teamName,
		code: r.teamCode,
		departmentName: r.deptName,
		isPrimary: Boolean(r.isPrimary),
		jobTitle: r.jobTitle
	}));

	const primary = mappedDepts.find((d) => d.isPrimary) ?? mappedDepts[0] ?? null;

	return {
		departments: mappedDepts,
		teams: mappedTeams,
		primaryPosition: primary?.position ?? null,
		primaryJobTitle: primary?.jobTitle ?? null
	};
}
