import { fail, error } from "@sveltejs/kit";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireAdminContext, assertNotLastAdmin, assertUserInTenant } from "$lib/server/auth/guards";
import { revokeAllUserSessions } from "$lib/server/auth/session";
import { revokeAllUserRefreshTokens } from "$lib/server/oidc/refresh";
import { recordAuditEvent, getRequestMetadata } from "$lib/server/audit/index";
import { departments, oidcClients, parts, positions, samlSps, serviceRoles, teams, userDepartments, userParts, userServiceAssignments, userTeams, users } from "$lib/server/db/schema";

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

    // 아래 조회는 서로 독립적이므로 병렬 실행한다. 순차 await 워터폴을 제거해
    // 관리자 상세 페이지 로드 지연을 대폭 단축한다.
    const [deptMemberships, teamMemberships, partMemberships, allDepts, allTeams, allParts, allPositions, assignments, allOidcClients, allSamlSps, allServiceRoles] = await Promise.all([
        // 현재 부서 소속
        db
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
            .where(and(eq(userDepartments.userId, userId), isNull(userDepartments.endedAt))),

        // 현재 팀 소속
        db
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
            .where(and(eq(userTeams.userId, userId), isNull(userTeams.endedAt))),

        // 현재 파트 소속
        db
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
            .where(and(eq(userParts.userId, userId), isNull(userParts.endedAt))),

        // 선택 목록
        db
            .select({ id: departments.id, name: departments.name })
            .from(departments)
            .where(and(eq(departments.tenantId, tenant.id), eq(departments.status, "active")))
            .orderBy(asc(departments.name)),

        db
            .select({ id: teams.id, name: teams.name, departmentName: departments.name })
            .from(teams)
            .leftJoin(departments, eq(teams.departmentId, departments.id))
            .where(and(eq(teams.tenantId, tenant.id), eq(teams.status, "active")))
            .orderBy(asc(departments.name), asc(teams.name)),

        db
            .select({ id: parts.id, name: parts.name, teamName: teams.name })
            .from(parts)
            .leftJoin(teams, eq(parts.teamId, teams.id))
            .where(and(eq(parts.tenantId, tenant.id), eq(parts.status, "active")))
            .orderBy(asc(teams.name), asc(parts.name)),

        db.select({ id: positions.id, name: positions.name, level: positions.level }).from(positions).where(eq(positions.tenantId, tenant.id)).orderBy(asc(positions.level)),

        // 서비스 권한 — 활성/만료/취소 모두 함께 보여 줌. 필터링은 UI 에서.
        db
            .select({
                id: userServiceAssignments.id,
                serviceType: userServiceAssignments.serviceType,
                serviceRefId: userServiceAssignments.serviceRefId,
                serviceRoleId: userServiceAssignments.serviceRoleId,
                roleKey: serviceRoles.key,
                roleLabel: serviceRoles.label,
                attributesJson: userServiceAssignments.attributesJson,
                grantedAt: userServiceAssignments.grantedAt,
                expiresAt: userServiceAssignments.expiresAt,
                revokedAt: userServiceAssignments.revokedAt,
            })
            .from(userServiceAssignments)
            .leftJoin(serviceRoles, eq(userServiceAssignments.serviceRoleId, serviceRoles.id))
            .where(and(eq(userServiceAssignments.tenantId, tenant.id), eq(userServiceAssignments.userId, userId))),

        db
            .select({ id: oidcClients.id, name: oidcClients.name, clientId: oidcClients.clientId })
            .from(oidcClients)
            .where(and(eq(oidcClients.tenantId, tenant.id), eq(oidcClients.enabled, true)))
            .orderBy(asc(oidcClients.name)),

        db
            .select({ id: samlSps.id, name: samlSps.name, entityId: samlSps.entityId })
            .from(samlSps)
            .where(and(eq(samlSps.tenantId, tenant.id), eq(samlSps.enabled, true)))
            .orderBy(asc(samlSps.name)),

        db
            .select({
                id: serviceRoles.id,
                serviceType: serviceRoles.serviceType,
                serviceRefId: serviceRoles.serviceRefId,
                key: serviceRoles.key,
                label: serviceRoles.label,
                isDefault: serviceRoles.isDefault,
                displayOrder: serviceRoles.displayOrder,
            })
            .from(serviceRoles)
            .where(eq(serviceRoles.tenantId, tenant.id))
            .orderBy(asc(serviceRoles.displayOrder), asc(serviceRoles.key)),
    ]);

    // 표시용 — service ref 별 이름 매핑
    const serviceLabelMap: Record<string, string> = {};
    for (const c of allOidcClients) serviceLabelMap[`oidc:${c.id}`] = `OIDC · ${c.name}`;
    for (const s of allSamlSps) serviceLabelMap[`saml:${s.id}`] = `SAML · ${s.name}`;

    return {
        user,
        deptMemberships,
        teamMemberships,
        partMemberships,
        allDepts,
        allTeams,
        allParts,
        allPositions,
        assignments,
        allOidcClients,
        allSamlSps,
        allServiceRoles,
        serviceLabelMap,
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

        // ctrls C-13: cross-tenant IDOR 차단. params.id 가 본 tenant user 인지 명시 검증.
        const tenantCheck = await assertUserInTenant(db, tenant.id, userId);
        if (!tenantCheck.ok) return tenantCheck.error;

        // 변경 전 role/status 캡처 — 자기-자신 가드, race 가드, role 변경 감지 모두에 사용
        const [before] = await db
            .select({ role: users.role, status: users.status })
            .from(users)
            .where(and(eq(users.id, userId), eq(users.tenantId, tenant.id)))
            .limit(1);

        // ctrls C-12: 자기 자신의 role/status 변경은 무조건 차단.
        // 값이 현재와 같더라도 폼 안에서 admin 이 자기 권한을 손대는 흐름 자체를
        // 차단해야 race 우회 가능성을 없앤다 (다른 admin 에게 요청해야 함).
        // 또한 폼이 전송한 role/status 를 무시하고 DB 현재 값을 그대로 유지한다.
        let effectiveRole = role;
        let effectiveStatus = status;
        if (userId === locals.user!.id) {
            if (before && (before.role !== role || before.status !== status)) {
                return fail(400, { error: "자기 자신의 role/status 는 변경할 수 없습니다. 다른 관리자에게 요청해 주세요." });
            }
            effectiveRole = before?.role ?? role;
            effectiveStatus = before?.status ?? status;
        }

        // 마지막 활성 관리자 보호 — admin 강등 또는 active 해제 시 사전 검사
        const isAdminRemoval = effectiveRole === "user" || effectiveStatus !== "active";
        if (isAdminRemoval) {
            const lastAdminFail = await assertNotLastAdmin(db, tenant.id, userId);
            if (lastAdminFail) return lastAdminFail;
        }

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
                role: effectiveRole,
                status: effectiveStatus,
                updatedAt: new Date(),
            })
            .where(and(eq(users.id, userId), eq(users.tenantId, tenant.id)));

        // ctrls C-12: race 가드 — UPDATE 직후 invariant 재확인.
        // 두 admin 이 동시에 서로 강등하면 사전 assertNotLastAdmin 가 둘 다
        // 통과해 0 admin 상태가 될 수 있다. UPDATE 직후 활성 admin 카운트를
        // 다시 세고 0 이면 본 UPDATE 의 role/status 만 즉시 되돌린다.
        if (isAdminRemoval) {
            const remaining = await db
                .select({ id: users.id })
                .from(users)
                .where(and(eq(users.tenantId, tenant.id), eq(users.role, "admin"), eq(users.status, "active")))
                .limit(1);
            if (remaining.length === 0 && before) {
                await db
                    .update(users)
                    .set({ role: before.role, status: before.status, updatedAt: new Date() })
                    .where(and(eq(users.id, userId), eq(users.tenantId, tenant.id)));
                return fail(409, { error: "동시에 다른 관리자도 강등된 것으로 보입니다. 변경을 취소했습니다. 다시 시도해 주세요." });
            }
        }

        // role 변경 시 기존 세션 + OIDC refresh token 전부 파기 — 이전 권한 캐시 차단
        if (before && before.role !== effectiveRole) {
            await revokeAllUserSessions(db, userId);
            await revokeAllUserRefreshTokens(db, userId);
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
            detail: { role: effectiveRole, status: effectiveStatus },
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

    // ── 서비스 권한 부여 ──────────────────────────────────────────────────────
    addAssignment: async (event) => {
        const { locals, params, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const userId = params.id;

        // ctrls C-13: 다른 tenant 의 userId 가 본 tenant 의 권한 row 로 박혀 들어가는
        // cross-tenant IDOR 차단. 기존엔 service ref 만 tenant 검증하고 userId 는
        // 검증 없이 INSERT 했음.
        const tenantCheck = await assertUserInTenant(db, tenant.id, userId);
        if (!tenantCheck.ok) return tenantCheck.error;

        // form 의 service 필드는 "oidc:<id>" 또는 "saml:<id>" 형태.
        const serviceRaw = String(fd.get("service") ?? "");
        const colonIdx = serviceRaw.indexOf(":");
        if (colonIdx <= 0) return fail(400, { error: "서비스를 선택해 주세요." });
        const serviceType = serviceRaw.slice(0, colonIdx);
        const serviceRefId = serviceRaw.slice(colonIdx + 1);
        if (serviceType !== "oidc" && serviceType !== "saml") return fail(400, { error: "잘못된 서비스 종류입니다." });
        if (!serviceRefId) return fail(400, { error: "잘못된 서비스 ID 입니다." });

        const serviceRoleIdRaw = String(fd.get("serviceRoleId") ?? "").trim();
        const serviceRoleId = serviceRoleIdRaw || null;
        const expiresAtRaw = String(fd.get("expiresAt") ?? "").trim();
        const attributesJsonRaw = String(fd.get("attributesJson") ?? "").trim();

        // service ref 가 우리 테넌트의 활성 서비스인지 검증
        if (serviceType === "oidc") {
            const [c] = await db
                .select({ id: oidcClients.id })
                .from(oidcClients)
                .where(and(eq(oidcClients.id, serviceRefId), eq(oidcClients.tenantId, tenant.id)))
                .limit(1);
            if (!c) return fail(404, { error: "OIDC 클라이언트를 찾을 수 없습니다." });
        } else {
            const [s] = await db
                .select({ id: samlSps.id })
                .from(samlSps)
                .where(and(eq(samlSps.id, serviceRefId), eq(samlSps.tenantId, tenant.id)))
                .limit(1);
            if (!s) return fail(404, { error: "SAML SP 를 찾을 수 없습니다." });
        }

        // role 이 지정됐다면, 같은 service 의 role 인지 검증
        if (serviceRoleId) {
            const [r] = await db
                .select({ id: serviceRoles.id })
                .from(serviceRoles)
                .where(and(eq(serviceRoles.id, serviceRoleId), eq(serviceRoles.tenantId, tenant.id), eq(serviceRoles.serviceType, serviceType), eq(serviceRoles.serviceRefId, serviceRefId)))
                .limit(1);
            if (!r) return fail(400, { error: "선택한 role 이 해당 서비스에 속하지 않습니다." });
        }

        let expiresAt: Date | null = null;
        if (expiresAtRaw) {
            const d = new Date(expiresAtRaw);
            if (Number.isNaN(d.getTime())) return fail(400, { error: "만료일 형식이 올바르지 않습니다." });
            expiresAt = d;
        }

        let attributesJson: string | null = null;
        if (attributesJsonRaw) {
            try {
                const parsed = JSON.parse(attributesJsonRaw) as unknown;
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    return fail(400, { error: "attributesJson 은 JSON object 여야 합니다." });
                }
                attributesJson = JSON.stringify(parsed);
            } catch {
                return fail(400, { error: "attributesJson 파싱 실패." });
            }
        }

        try {
            await db.insert(userServiceAssignments).values({
                id: crypto.randomUUID(),
                tenantId: tenant.id,
                userId,
                serviceType,
                serviceRefId,
                serviceRoleId,
                attributesJson,
                grantedBy: locals.user!.id,
                expiresAt,
            });
        } catch {
            // unique (tenantId, userId, serviceType, serviceRefId)
            return fail(409, { error: "이미 해당 서비스에 매핑이 존재합니다. 먼저 삭제해 주세요." });
        }

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId,
            actorId: locals.user!.id,
            spOrClientId: serviceRefId,
            kind: "service_assignment_granted",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { serviceType, serviceRefId, serviceRoleId, expiresAt },
        });

        return { addedAssignment: true };
    },

    revokeAssignment: async (event) => {
        const { locals, params, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const assignmentId = String(fd.get("assignmentId") ?? "");
        if (!assignmentId) return fail(400, { error: "잘못된 요청." });

        // IDOR 가드: 본 페이지 user 의 assignment 만 영향
        await db.delete(userServiceAssignments).where(and(eq(userServiceAssignments.id, assignmentId), eq(userServiceAssignments.userId, params.id), eq(userServiceAssignments.tenantId, tenant.id)));

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            userId: params.id,
            actorId: locals.user!.id,
            kind: "service_assignment_revoked",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { assignmentId },
        });

        return { revokedAssignment: true };
    },

    updateAssignmentExpiry: async (event) => {
        const { locals, params, request } = event;
        const { db, tenant } = requireAdminContext(locals);
        const fd = await request.formData();
        const assignmentId = String(fd.get("assignmentId") ?? "");
        if (!assignmentId) return fail(400, { error: "잘못된 요청." });

        const expiresAtRaw = String(fd.get("expiresAt") ?? "").trim();
        let expiresAt: Date | null = null;
        if (expiresAtRaw) {
            const d = new Date(expiresAtRaw);
            if (Number.isNaN(d.getTime())) return fail(400, { error: "만료일 형식이 올바르지 않습니다." });
            expiresAt = d;
        }

        await db
            .update(userServiceAssignments)
            .set({ expiresAt })
            .where(and(eq(userServiceAssignments.id, assignmentId), eq(userServiceAssignments.userId, params.id), eq(userServiceAssignments.tenantId, tenant.id)));

        return { updatedExpiry: true };
    },
};
