import { fail, error } from "@sveltejs/kit";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireAdminContext, assertNotLastAdmin } from "$lib/server/auth/guards";
import { revokeAllUserSessions } from "$lib/server/auth/session";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import { departments, parts, positions, teams, userDepartments, userParts, userTeams, users } from "$lib/server/db/schema";

export const load: PageServerLoad = async ({ locals, params }) => {
    const { db, tenant } = requireAdminContext(locals);
    const userId = params.id;

    // 유저 조회
    const [user] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, userId), eq(users.tenantId, tenant.id)))
        .limit(1);

    if (!user) error(404, "사용자를 찾을 수 없습니다.");

    // 현재 부서 소속
    const deptMemberships = await db
        .select({
            id: userDepartments.id,
            departmentId: userDepartments.departmentId,
            departmentName: departments.name,
            positionId: userDepartments.positionId,
            positionName: positions.name,
            jobTitle: userDepartments.jobTitle,
            isPrimary: userDepartments.isPrimary,
            startedAt: userDepartments.startedAt,
        })
        .from(userDepartments)
        .innerJoin(departments, eq(userDepartments.departmentId, departments.id))
        .leftJoin(positions, eq(userDepartments.positionId, positions.id))
        .where(and(eq(userDepartments.userId, userId), isNull(userDepartments.endedAt)));

    // 현재 팀 소속
    const teamMemberships = await db
        .select({
            id: userTeams.id,
            teamId: userTeams.teamId,
            teamName: teams.name,
            departmentName: departments.name,
            jobTitle: userTeams.jobTitle,
            isPrimary: userTeams.isPrimary,
            startedAt: userTeams.startedAt,
        })
        .from(userTeams)
        .innerJoin(teams, eq(userTeams.teamId, teams.id))
        .leftJoin(departments, eq(teams.departmentId, departments.id))
        .where(and(eq(userTeams.userId, userId), isNull(userTeams.endedAt)));

    // 현재 파트 소속
    const partMemberships = await db
        .select({
            id: userParts.id,
            partId: userParts.partId,
            partName: parts.name,
            teamName: teams.name,
            jobTitle: userParts.jobTitle,
            isPrimary: userParts.isPrimary,
            startedAt: userParts.startedAt,
        })
        .from(userParts)
        .innerJoin(parts, eq(userParts.partId, parts.id))
        .leftJoin(teams, eq(parts.teamId, teams.id))
        .where(and(eq(userParts.userId, userId), isNull(userParts.endedAt)));

    // 선택 목록
    const allDepts = await db
        .select({ id: departments.id, name: departments.name })
        .from(departments)
        .where(and(eq(departments.tenantId, tenant.id), eq(departments.status, "active")))
        .orderBy(asc(departments.name));

    const allTeams = await db
        .select({ id: teams.id, name: teams.name, departmentName: departments.name })
        .from(teams)
        .leftJoin(departments, eq(teams.departmentId, departments.id))
        .where(and(eq(teams.tenantId, tenant.id), eq(teams.status, "active")))
        .orderBy(asc(departments.name), asc(teams.name));

    const allParts = await db
        .select({ id: parts.id, name: parts.name, teamName: teams.name })
        .from(parts)
        .leftJoin(teams, eq(parts.teamId, teams.id))
        .where(and(eq(parts.tenantId, tenant.id), eq(parts.status, "active")))
        .orderBy(asc(teams.name), asc(parts.name));

    const allPositions = await db.select({ id: positions.id, name: positions.name, level: positions.level }).from(positions).where(eq(positions.tenantId, tenant.id)).orderBy(asc(positions.level));

    return {
        user,
        deptMemberships,
        teamMemberships,
        partMemberships,
        allDepts,
        allTeams,
        allParts,
        allPositions,
    };
};

export const actions: Actions = {
    // 프로필 수정
    updateProfile: async (event) => {
        const { locals, params, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const userId = params.id;

        const rawRole = String(fd.get("role") ?? "user");
        const rawStatus = String(fd.get("status") ?? "active");

        if (rawRole !== "admin" && rawRole !== "user") {
            return fail(400, { error: "잘못된 role 값입니다." });
        }
        if (rawStatus !== "active" && rawStatus !== "disabled" && rawStatus !== "locked") {
            return fail(400, { error: "잘못된 status 값입니다." });
        }

        const role = rawRole as "admin" | "user";
        const status = rawStatus as "active" | "disabled" | "locked";

        // 자기 자신의 role/status 변경 방지
        if (userId === locals.user!.id) {
            // 현재 자신의 값과 다른 변경을 시도하면 차단
            const [self] = await db
                .select({ role: users.role, status: users.status })
                .from(users)
                .where(and(eq(users.id, userId), eq(users.tenantId, tenant.id)))
                .limit(1);
            if (self && (self.role !== role || self.status !== status)) {
                return fail(400, { error: "자기 자신의 role/status는 변경할 수 없습니다." });
            }
        }

        // 마지막 활성 관리자 보호 — admin 강등 또는 active 해제 시 검사
        if (role === "user" || status !== "active") {
            const lastAdminFail = await assertNotLastAdmin(db, tenant.id, userId);
            if (lastAdminFail) return lastAdminFail;
        }

        // 변경 전 role 을 캡처해 변경 여부 판단
        const [before] = await db
            .select({ role: users.role })
            .from(users)
            .where(and(eq(users.id, userId), eq(users.tenantId, tenant.id)))
            .limit(1);

        const displayName = String(fd.get("displayName") ?? "").trim() || null;
        const givenName = String(fd.get("givenName") ?? "").trim() || null;
        const familyName = String(fd.get("familyName") ?? "").trim() || null;
        const phoneNumber = String(fd.get("phoneNumber") ?? "").trim() || null;
        const bio = String(fd.get("bio") ?? "").trim() || null;
        const birthdate = String(fd.get("birthdate") ?? "").trim() || null;
        const locale = String(fd.get("locale") ?? "ko-KR").trim();
        const zoneinfo = String(fd.get("zoneinfo") ?? "Asia/Seoul").trim();

        await db
            .update(users)
            .set({
                displayName,
                givenName,
                familyName,
                phoneNumber,
                bio,
                birthdate,
                locale,
                zoneinfo,
                role,
                status,
                updatedAt: new Date(),
            })
            .where(and(eq(users.id, userId), eq(users.tenantId, tenant.id)));

        // role 변경 시 기존 세션 전부 파기 — 이전 권한 캐시 차단
        if (before && before.role !== role) {
            await revokeAllUserSessions(db, userId);
        }

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId,
            actorId: locals.user!.id,
            kind: "user_profile_updated",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { role, status },
        });

        return { updated: true };
    },

    // 부서 소속 추가
    addDept: async (event) => {
        const { locals, params, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const userId = params.id;
        const departmentId = String(fd.get("departmentId") ?? "");
        const positionId = String(fd.get("positionId") ?? "").trim() || null;
        const jobTitle = String(fd.get("jobTitle") ?? "").trim() || null;
        const isPrimary = fd.get("isPrimary") === "true";

        if (!departmentId) return fail(400, { error: "부서를 선택해 주세요." });

        const [targetUser] = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, userId), eq(users.tenantId, tenant.id)))
            .limit(1);
        if (!targetUser) return fail(404, { error: "사용자를 찾을 수 없습니다." });

        const [dept] = await db
            .select({ id: departments.id })
            .from(departments)
            .where(and(eq(departments.id, departmentId), eq(departments.tenantId, tenant.id)))
            .limit(1);
        if (!dept) return fail(404, { error: "부서를 찾을 수 없습니다." });

        if (positionId) {
            const [pos] = await db
                .select({ id: positions.id })
                .from(positions)
                .where(and(eq(positions.id, positionId), eq(positions.tenantId, tenant.id)))
                .limit(1);
            if (!pos) return fail(404, { error: "직책을 찾을 수 없습니다." });
        }

        const membershipId = crypto.randomUUID();
        await db.insert(userDepartments).values({ id: membershipId, tenantId: tenant.id, userId, departmentId, positionId, jobTitle, isPrimary });

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId,
            actorId: locals.user!.id,
            kind: "membership_change",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { membershipId, action: "add_dept", departmentId, positionId, isPrimary },
        });

        return { addedDept: true };
    },

    // 부서 소속 제거 (endedAt 설정)
    removeDept: async (event) => {
        const { locals, params, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const membershipId = String(fd.get("membershipId") ?? "");
        if (!membershipId) return fail(400, { error: "잘못된 요청입니다." });

        // IDOR 방어: membershipId가 본 페이지의 userId 소유인지도 확인
        const result = await db
            .update(userDepartments)
            .set({ endedAt: new Date() })
            .where(and(eq(userDepartments.id, membershipId), eq(userDepartments.userId, params.id), eq(userDepartments.tenantId, tenant.id)));

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: params.id,
            actorId: locals.user!.id,
            kind: "membership_change",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { membershipId, action: "remove_dept" },
        });

        void result;
        return { removedDept: true };
    },

    // 팀 소속 추가
    addTeam: async (event) => {
        const { locals, params, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const userId = params.id;
        const teamId = String(fd.get("teamId") ?? "");
        const jobTitle = String(fd.get("jobTitle") ?? "").trim() || null;
        const isPrimary = fd.get("isPrimary") === "true";

        if (!teamId) return fail(400, { error: "팀을 선택해 주세요." });

        const [targetUser] = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, userId), eq(users.tenantId, tenant.id)))
            .limit(1);
        if (!targetUser) return fail(404, { error: "사용자를 찾을 수 없습니다." });

        const [team] = await db
            .select({ id: teams.id })
            .from(teams)
            .where(and(eq(teams.id, teamId), eq(teams.tenantId, tenant.id)))
            .limit(1);
        if (!team) return fail(404, { error: "팀을 찾을 수 없습니다." });

        const membershipId = crypto.randomUUID();
        await db.insert(userTeams).values({ id: membershipId, tenantId: tenant.id, userId, teamId, jobTitle, isPrimary });

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId,
            actorId: locals.user!.id,
            kind: "membership_change",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { membershipId, action: "add_team", teamId, isPrimary },
        });

        return { addedTeam: true };
    },

    // 팀 소속 제거
    removeTeam: async (event) => {
        const { locals, params, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const membershipId = String(fd.get("membershipId") ?? "");
        if (!membershipId) return fail(400, { error: "잘못된 요청입니다." });

        await db
            .update(userTeams)
            .set({ endedAt: new Date() })
            .where(and(eq(userTeams.id, membershipId), eq(userTeams.userId, params.id), eq(userTeams.tenantId, tenant.id)));

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: params.id,
            actorId: locals.user!.id,
            kind: "membership_change",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { membershipId, action: "remove_team" },
        });

        return { removedTeam: true };
    },

    // 파트 소속 추가
    addPart: async (event) => {
        const { locals, params, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const userId = params.id;
        const partId = String(fd.get("partId") ?? "");
        const jobTitle = String(fd.get("jobTitle") ?? "").trim() || null;
        const isPrimary = fd.get("isPrimary") === "true";

        if (!partId) return fail(400, { error: "파트를 선택해 주세요." });

        const [targetUser] = await db
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.id, userId), eq(users.tenantId, tenant.id)))
            .limit(1);
        if (!targetUser) return fail(404, { error: "사용자를 찾을 수 없습니다." });

        const [part] = await db
            .select({ id: parts.id })
            .from(parts)
            .where(and(eq(parts.id, partId), eq(parts.tenantId, tenant.id)))
            .limit(1);
        if (!part) return fail(404, { error: "파트를 찾을 수 없습니다." });

        const membershipId = crypto.randomUUID();
        await db.insert(userParts).values({ id: membershipId, tenantId: tenant.id, userId, partId, jobTitle, isPrimary });

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId,
            actorId: locals.user!.id,
            kind: "membership_change",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { membershipId, action: "add_part", partId, isPrimary },
        });

        return { addedPart: true };
    },

    // 파트 소속 제거
    removePart: async (event) => {
        const { locals, params, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const membershipId = String(fd.get("membershipId") ?? "");
        if (!membershipId) return fail(400, { error: "잘못된 요청입니다." });

        await db
            .update(userParts)
            .set({ endedAt: new Date() })
            .where(and(eq(userParts.id, membershipId), eq(userParts.userId, params.id), eq(userParts.tenantId, tenant.id)));

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: params.id,
            actorId: locals.user!.id,
            kind: "membership_change",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { membershipId, action: "remove_part" },
        });

        return { removedPart: true };
    },
};
