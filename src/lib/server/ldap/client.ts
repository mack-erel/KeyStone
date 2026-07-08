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
        ...(config.tlsMode === "tls" || config.tlsMode === "starttls" ? { tlsOptions: { rejectUnauthorized: true } } : {}),
    });
}

// ctrls H-API-2: starttls 모드는 반드시 bind 전에 STARTTLS extended operation 을
// 실제로 협상해야 한다. 예전에는 buildUrl 이 ldap://(평문) 을 반환하고 tlsOptions 만
// 설정한 채 STARTTLS 를 호출하지 않아, 관리자가 "암호화(starttls)"를 선택했음에도
// bind 자격증명·사용자 비밀번호가 평문 소켓으로 전송됐다. 업그레이드가 실패하면
// 평문 bind 로 진행하지 않고 fail-closed 한다 (다운그레이드 방지).
function connectLdapClient(config: LdapProviderConfig): Promise<ldap.Client> {
    const client = createLdapClient(config);
    if (config.tlsMode !== "starttls") return Promise.resolve(client);

    // 일부 타입 정의에 starttls/destroy 가 노출되지 않아 명시 캐스팅.
    const tlsClient = client as unknown as {
        starttls: (options: Record<string, unknown>, controls: unknown[], callback: (err: Error | null) => void) => void;
        destroy?: () => void;
    };

    return new Promise<ldap.Client>((resolve, reject) => {
        let settled = false;
        const failClosed = (err: Error) => {
            if (settled) return;
            settled = true;
            try {
                tlsClient.destroy?.();
            } catch {
                /* noop */
            }
            reject(err);
        };
        client.on("error", failClosed);
        tlsClient.starttls({ rejectUnauthorized: true }, [], (err: Error | null) => {
            if (settled) return;
            if (err) {
                failClosed(err);
                return;
            }
            settled = true; // 성공 — 이후 lingering error 핸들러는 outer 함수가 처리한다.
            resolve(client);
        });
    });
}

/** DN + 패스워드로 LDAP bind. 실패 시 throw. 빈 패스워드는 anonymous bind 가 되므로 거부. */
export async function ldapBind(config: LdapProviderConfig, dn: string, password: string): Promise<void> {
    if (!password) {
        // RFC 4513 §5.1.2 — empty password 는 anonymous bind 로 성공 처리되므로 명시적으로 거부.
        throw new Error("LDAP bind: empty password is not allowed");
    }
    if (!dn) {
        throw new Error("LDAP bind: empty DN is not allowed");
    }
    const client = await connectLdapClient(config);
    return new Promise((resolve, reject) => {
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
    const client = await connectLdapClient(config);
    return new Promise((resolve, reject) => {
        client.on("error", (err: Error) => {
            reject(err);
        });

        client.bind(bindDn, bindPassword, (bindErr: Error | null) => {
            if (bindErr) {
                client.unbind();
                reject(bindErr);
                return;
            }

            client.search(config.baseDN, { scope: "sub", filter, attributes: ["dn"], derefAliases: 0 }, (searchErr: Error | null, res: ldap.SearchCallbackResponse) => {
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
    const client = await connectLdapClient(config);
    return new Promise((resolve, reject) => {
        client.on("error", (err: Error) => {
            reject(err);
        });

        client.bind(bindDn, bindPassword, (bindErr: Error | null) => {
            if (bindErr) {
                client.unbind();
                reject(bindErr);
                return;
            }

            client.search(entryDn, { scope: "base", filter: "(objectClass=*)", attributes, derefAliases: 0 }, (searchErr: Error | null, res: ldap.SearchCallbackResponse) => {
                if (searchErr) {
                    client.unbind();
                    reject(searchErr);
                    return;
                }

                let entry: Record<string, string> | null = null;

                res.on("searchEntry", (e: ldap.SearchEntry) => {
                    const obj: Record<string, string> = {};
                    for (const attr of e.attributes) {
                        obj[attr.type] = Array.isArray(attr.vals) ? (attr.vals[0] ?? "") : "";
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
