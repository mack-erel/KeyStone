export interface RuntimeConfig {
    defaultTenantName: string;
    issuerUrl?: string;
    signingKeySecret?: string;
}

type EnvLookup = Record<string, unknown>;

function getString(env: EnvLookup | undefined, key: string): string | undefined {
    const value = env?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getRuntimeConfig(platform: App.Platform | undefined): RuntimeConfig {
    const env = platform?.env as EnvLookup | undefined;

    return {
        defaultTenantName: getString(env, "IDP_DEFAULT_TENANT_NAME") ?? "Default Tenant",
        issuerUrl: getString(env, "IDP_ISSUER_URL")?.trim().replace(/\/$/, ""),
        signingKeySecret: getString(env, "IDP_SIGNING_KEY_SECRET"),
    };
}
