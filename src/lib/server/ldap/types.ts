export interface LdapProviderConfig {
	host: string;
	port: number;
	baseDN: string;
	/**
	 * 유저 DN 패턴. {username} 이 실제 username 으로 치환됨.
	 * bindDN 이 설정된 경우 Search 방식을 사용하므로 이 값은 무시됨.
	 * 예: "uid={username},dc=example,dc=com"
	 */
	userDnPattern?: string;
	/** none = ldap://, tls = ldaps://, starttls = STARTTLS */
	tlsMode: 'none' | 'tls' | 'starttls';
	/**
	 * Search 방식 사용 시 Admin Bind DN.
	 * 설정되면 이 계정으로 먼저 bind → uid 검색 → 유저 DN 확인 → 유저 bind.
	 * ou 가 여러 개인 LDAP 서버(forumsys 등)에 필요.
	 */
	bindDN?: string;
	/** Admin Bind 패스워드 (평문 — 레거시 호환용, 신규 저장 시 bindPasswordEnc 사용) */
	bindPassword?: string;
	/** Admin Bind 패스워드 암호화 값 (AES-256-GCM, encryptSecret 형식) */
	bindPasswordEnc?: string;
	/** 유저 검색 필터. 기본: "(uid={username})" */
	userSearchFilter?: string;
	/** LDAP 속성 → IDP 필드 매핑 */
	attributeMap?: {
		email?: string; // 기본: 'mail'
		displayName?: string; // 기본: 'cn'
		givenName?: string; // 기본: 'givenName'
		familyName?: string; // 기본: 'sn'
	};
}

export interface LdapUserAttrs {
	dn: string;
	username: string;
	email: string;
	displayName: string | null;
	givenName: string | null;
	familyName: string | null;
}
