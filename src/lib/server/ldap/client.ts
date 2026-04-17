import ldap from "@yrneh_jang/ldapjs";
import type { LdapProviderConfig } from "./types";

function buildUrl(config: LdapProviderConfig): string {
    const scheme = config.tlsMode === "tls" ? "ldaps" : "ldap";
    return `${scheme}://${config.host}:${config.port}`;
}

function createLdapClient(config: LdapProviderConfig): ldap.Client {
    return ldap.createClient({
        url: buildUrl(config),
        connectTimeout: 5000,
        timeout: 5000,
        ...(config.tlsMode === "tls" ? { tlsOptions: { rejectUnauthorized: true } } : {}),
    });
}

/** DN + 패스워드로 LDAP bind. 실패 시 throw. */
export async function ldapBind(config: LdapProviderConfig, dn: string, password: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const client = createLdapClient(config);

        client.on("error", (err: Error) => {
            reject(err);
        });

        client.bind(dn, password, (err: Error | null) => {
            client.unbind();
            if (err) reject(err);
            else resolve();
        });
    });
}

/**
 * Admin bind 후 baseDN 아래에서 filter 에 맞는 첫 번째 엔트리의 DN 을 반환한다.
 * ou 가 여러 개인 서버에서 유저 DN 을 찾을 때 사용.
 */
export async function ldapSearchDn(config: LdapProviderConfig, bindDn: string, bindPassword: string, filter: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
        const client = createLdapClient(config);

        client.on("error", (err: Error) => {
            reject(err);
        });

        client.bind(bindDn, bindPassword, (bindErr: Error | null) => {
            if (bindErr) {
                client.unbind();
                reject(bindErr);
                return;
            }

            client.search(config.baseDN, { scope: "sub", filter, attributes: ["dn"] }, (searchErr: Error | null, res: ldap.SearchCallbackResponse) => {
                if (searchErr) {
                    client.unbind();
                    reject(searchErr);
                    return;
                }

                let foundDn: string | null = null;

                res.on("searchEntry", (e: ldap.SearchEntry) => {
                    if (!foundDn) foundDn = e.dn.toString();
                });

                res.on("error", (err: Error) => {
                    client.unbind();
                    reject(err);
                });

                res.on("end", () => {
                    client.unbind();
                    resolve(foundDn);
                });
            });
        });
    });
}

/** bind 후 단일 엔트리의 속성을 조회한다. */
export async function ldapFetchEntry(config: LdapProviderConfig, bindDn: string, bindPassword: string, entryDn: string, attributes: string[]): Promise<Record<string, string> | null> {
    return new Promise((resolve, reject) => {
        const client = createLdapClient(config);

        client.on("error", (err: Error) => {
            reject(err);
        });

        client.bind(bindDn, bindPassword, (bindErr: Error | null) => {
            if (bindErr) {
                client.unbind();
                reject(bindErr);
                return;
            }

            client.search(entryDn, { scope: "base", filter: "(objectClass=*)", attributes }, (searchErr: Error | null, res: ldap.SearchCallbackResponse) => {
                if (searchErr) {
                    client.unbind();
                    reject(searchErr);
                    return;
                }

                let entry: Record<string, string> | null = null;

                res.on("searchEntry", (e: ldap.SearchEntry) => {
                    const obj: Record<string, string> = {};
                    for (const attr of e.attributes) {
                        obj[attr.type] = Array.isArray(attr.values) ? (attr.values[0] ?? "") : "";
                    }
                    entry = obj;
                });

                res.on("error", (err: Error) => {
                    client.unbind();
                    reject(err);
                });

                res.on("end", () => {
                    client.unbind();
                    resolve(entry);
                });
            });
        });
    });
}
