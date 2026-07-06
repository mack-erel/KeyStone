import { fail } from "@sveltejs/kit";
import { and, desc, eq } from "drizzle-orm";
import type { Actions, PageServerLoad } from "./$types";
import { requireAdminContext } from "$lib/server/auth/guards";
import { adminError, requireFormId } from "$lib/server/admin/errors";
import { getRequestMetadata, recordAuditEvent } from "$lib/server/audit";
import { getRuntimeConfig } from "$lib/server/auth/runtime";
import { encryptSecret } from "$lib/server/crypto/keys";
import { identityProviders } from "$lib/server/db/schema";
import type { LdapProviderConfig } from "$lib/server/ldap/types";
import { validateLdapHost, validateLdapPort } from "$lib/server/validation";
import type { Locale } from "$lib/i18n/core";

function buildConfig(fd: FormData): LdapProviderConfig {
    const port = parseInt(String(fd.get("port") ?? "389"), 10);
    const tlsMode = String(fd.get("tlsMode") ?? "none") as "none" | "tls" | "starttls";

    const bindDN = String(fd.get("bindDN") ?? "").trim();
    const bindPassword = String(fd.get("bindPassword") ?? "").trim();
    const userDnPattern = String(fd.get("userDnPattern") ?? "").trim();
    const userSearchFilter = String(fd.get("userSearchFilter") ?? "").trim();

    const config: LdapProviderConfig = {
        host: String(fd.get("host") ?? "").trim(),
        port: isNaN(port) ? 389 : port,
        baseDN: String(fd.get("baseDN") ?? "").trim(),
        tlsMode,
    };

    if (bindDN) {
        config.bindDN = bindDN;
        if (bindPassword) config.bindPassword = bindPassword;
        if (userSearchFilter) config.userSearchFilter = userSearchFilter;
    } else if (userDnPattern) {
        config.userDnPattern = userDnPattern;
    }

    // 속성 매핑 — 기본값과 다를 때만 포함
    const email = String(fd.get("attrEmail") ?? "").trim();
    const displayName = String(fd.get("attrDisplayName") ?? "").trim();
    const givenName = String(fd.get("attrGivenName") ?? "").trim();
    const familyName = String(fd.get("attrFamilyName") ?? "").trim();

    if (email || displayName || givenName || familyName) {
        config.attributeMap = {};
        if (email) config.attributeMap.email = email;
        if (displayName) config.attributeMap.displayName = displayName;
        if (givenName) config.attributeMap.givenName = givenName;
        if (familyName) config.attributeMap.familyName = familyName;
    }

    return config;
}

// ctrls H-ADMIN-4: signingKeySecret 가 미설정인 상태에서 bindPassword 가 입력되면
// 평문 그대로 저장하던 silent fallback 을 제거. 운영 환경 (signingKeySecret 항상
// 존재) 에서 정상 동작, dev 환경에서 secret 미설정 시 admin 에게 명시적 에러로
// 알려 평문 LDAP 자격증명이 DB 에 박히는 사고 차단.
async function encryptBindPassword(config: LdapProviderConfig, signingKeySecret: string | undefined, locale: Locale): Promise<LdapProviderConfig> {
    if (!config.bindPassword) {
        // 새 bindPassword 입력이 없으면 그대로 통과 (기존 enc 만 보존됨)
        return config;
    }
    if (!signingKeySecret) {
        throw new Error(adminError(locale, "ldap_signing_key_secret_required"));
    }
    const enc = await encryptSecret(config.bindPassword, signingKeySecret, "idp-ldap-bind-password-v1");
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { bindPassword: _, ...rest } = config;
    return { ...rest, bindPasswordEnc: enc };
}

export const load: PageServerLoad = async ({ locals }) => {
    const { db, tenant } = requireAdminContext(locals);

    const rows = await db
        .select()
        .from(identityProviders)
        .where(and(eq(identityProviders.tenantId, tenant.id), eq(identityProviders.kind, "ldap")))
        .orderBy(desc(identityProviders.createdAt));

    return { providers: rows };
};

export const actions: Actions = {
    create: async (event) => {
        const { db, tenant } = requireAdminContext(event.locals);
        const locale = event.locals.locale;
        const fd = await event.request.formData();

        const name = String(fd.get("name") ?? "").trim();
        const host = String(fd.get("host") ?? "").trim();
        const hasBind = String(fd.get("bindDN") ?? "").trim();
        const hasPattern = String(fd.get("userDnPattern") ?? "").trim();

        if (!name) return fail(400, { create: true, error: adminError(locale, "name_required") });
        if (!host) return fail(400, { create: true, error: adminError(locale, "ldap_host_required") });
        if (!hasBind && !hasPattern)
            return fail(400, {
                create: true,
                error: adminError(locale, "ldap_bind_or_userdn_required"),
            });

        const hostV = validateLdapHost(host);
        if (!hostV.ok) return fail(400, { create: true, error: hostV.reason });

        const port = parseInt(String(fd.get("port") ?? "389"), 10);
        const portV = validateLdapPort(isNaN(port) ? 389 : port);
        if (!portV.ok) return fail(400, { create: true, error: portV.reason });

        const { signingKeySecret } = getRuntimeConfig(event.platform);
        let config: LdapProviderConfig;
        try {
            config = await encryptBindPassword(buildConfig(fd), signingKeySecret, locale);
        } catch (e) {
            return fail(503, { create: true, error: (e as Error).message });
        }

        await db.insert(identityProviders).values({
            tenantId: tenant.id,
            kind: "ldap",
            name,
            configJson: JSON.stringify(config),
            enabled: false,
        });

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: event.locals.user!.id,
            kind: "ldap_provider_created",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { name },
        });

        return { create: true };
    },

    update: async (event) => {
        const { db, tenant } = requireAdminContext(event.locals);
        const locale = event.locals.locale;
        const fd = await event.request.formData();

        const id = String(fd.get("id") ?? "");
        const name = String(fd.get("name") ?? "").trim();
        const enabled = fd.get("enabled") === "true";

        if (!id || !name) return fail(400, { error: adminError(locale, "invalid_request") });

        const host = String(fd.get("host") ?? "").trim();
        if (host) {
            const hostV = validateLdapHost(host);
            if (!hostV.ok) return fail(400, { error: hostV.reason });
        }
        const port = parseInt(String(fd.get("port") ?? "389"), 10);
        const portV = validateLdapPort(isNaN(port) ? 389 : port);
        if (!portV.ok) return fail(400, { error: portV.reason });

        const { signingKeySecret } = getRuntimeConfig(event.platform);
        let config: LdapProviderConfig;
        try {
            config = await encryptBindPassword(buildConfig(fd), signingKeySecret, locale);
        } catch (e) {
            return fail(503, { error: (e as Error).message });
        }

        await db
            .update(identityProviders)
            .set({ name, configJson: JSON.stringify(config), enabled, updatedAt: new Date() })
            .where(and(eq(identityProviders.id, id), eq(identityProviders.tenantId, tenant.id)));

        return { update: true };
    },

    delete: async (event) => {
        const { db, tenant } = requireAdminContext(event.locals);
        const locale = event.locals.locale;
        const fd = await event.request.formData();

        const idr = requireFormId(fd, locale);
        if (!idr.ok) return idr.failure;
        const id = idr.id;

        await db.delete(identityProviders).where(and(eq(identityProviders.id, id), eq(identityProviders.tenantId, tenant.id)));

        const meta = getRequestMetadata(event);
        await recordAuditEvent(db, {
            tenantId: tenant.id,
            actorId: event.locals.user!.id,
            kind: "ldap_provider_deleted",
            outcome: "success",
            ip: meta.ip,
            userAgent: meta.userAgent,
            detail: { id },
        });

        return { deleted: true };
    },
};
