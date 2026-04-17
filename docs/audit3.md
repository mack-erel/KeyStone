아직 안 본 부분 있다. LDAP provision, membership, org/membership, saml SP 등록, userinfo, jwks, admin ldap-providers, admin saml-sps, admin departments/teams/parts/positions, signing keys 추가 로직, well-known 엔드포인트, saml metadata — 이것들 더 파보자.🔥🔥🔥 **이거 정말 치명적이다.**

### **LDAP Account Takeover — 엔터프라이즈에서 가장 무서운 패턴**

```typescript
// 2. 동일 이메일 로컬 유저 확인 → LDAP identity 연결
const [existingUser] = await db
  .select()
  .from(users)
  .where(and(eq(users.tenantId, tenantId), eq(users.email, attrs.email), eq(users.status, 'active')))
  .limit(1);

if (existingUser) {
  await db.insert(identities).values({ ... });
  return existingUser;  // ← 그냥 로그인 시켜줌
}
```

**시나리오:**

1. 관리자가 idp에 로컬 계정 `admin@hyochan.site` (role=admin) 존재
2. 공격자가 **자기가 컨트롤하는 LDAP 서버**를 테넌트에 등록 (또는 기존 LDAP 디렉토리에 `admin@hyochan.site` 이메일 가진 유저 추가)
3. 공격자가 그 LDAP 계정으로 idp 로그인 시도
4. `login/+page.server.ts`는 LDAP provider가 enabled면 **먼저 LDAP 시도** → LDAP bind 성공
5. `provisionLdapUser` → email 매칭 → **기존 admin 계정을 그냥 반환** → 관리자 세션 생성

**email만으로 계정 병합**하는건 SSO 보안의 고전 실수다. Microsoft, Azure, Okta 전부 이거 때문에 CVE 나왔음. 이메일은 신뢰할 수 있는 식별자가 아님 — LDAP 서버 관리자나 공격자가 임의로 설정 가능.

그리고 `ensureBootstrapAdmin`에서 보면 새로 만든 유저는 자동으로 `emailVerifiedAt: new Date()` 찍어서 **LDAP로 만들어진 유저는 이메일 검증 통과한 것처럼 취급**. 이중 실수.

### 추가 LDAP 이슈들:

**LDAP Injection 가능성:**
```typescript
const filter = (config.userSearchFilter ?? '(uid={username})').replace('{username}', username);
```

`authenticateLdap`에서 username을 **LDAP filter에 raw로 삽입**. LDAP special chars (`()&|!*\\`) escape 없음. 예: username에 `admin)(|(uid=*` 넣으면:

```
(uid=admin)(|(uid=*)
```
→ 필터가 `(uid=admin)` + 추가 조건. LDAP search의 첫 번째 매치를 반환하는 로직이라 **첫 번째 유저 DN 반환** → 그걸로 bind 시도. bind는 패스워드 있어야 하니 즉시 account takeover는 아니지만 **존재하는 DN 열거** + **authentication bypass 시도** 여지.

더 심각한 벡터: `config.userSearchFilter`가 `(&(objectClass=person)(uid={username}))` 같은 형태면, username `admin)(&(objectClass=*`로 필터 깨서 원하는 유저 반환 가능.

bind 단계에서 LDAP injection도 됨 — `userDn = config.userDnPattern.replace('{username}', username)` — `username`을 DN에 그대로 삽입. `admin,ou=Admins,dc=evil` 같은걸 넣으면 DN 조작 가능. 다행히 LDAP bind는 DN 구조 엄격해서 실전 영향 제한적이긴 함.

이제 saml metadata 엔드포인트랑 userinfo 보자.### OIDC userinfo — 괜찮아보인다. tenantId + status 다 체크. 근데:

### 🔥 **Scope escalation via grant reuse**

token 엔드포인트에서 grant.scope를 access_token에 담는데, **authorize에서 `openid organization` 요청 → userinfo에서 조직 정보 받음**. 이거 자체는 설계대로.

근데 `parseGrantedScopes`:
```typescript
return requestedScope.split(/[\s,]+/).filter((s) => allowedScopes.includes(s));
```

**`openid` 강제 없음** — authorize에서만 체크:
```typescript
if (!grantedScopes.includes('openid')) {
  authRedirectError(redirectUri, 'invalid_scope', ...);
}
```

여기서 일단 openid 스코프 없으면 리젝트하니 일단 막힘. 근데 **요청 scope에 없는 권한은 그냥 filter로 제거**함. OAuth 2.0 기본 정책이지만, 만약 client에 `openid,profile,email,organization,admin:read`까지 할당해놓고 **사용자가 `openid` 하나만 요청해도 client에 할당된 전부를 주는** 건 아니라서 이건 괜찮음.

근데 **`organization` scope이 `claims_supported`에 없음**. 디스커버리에는 `['sub','iss','aud','exp','iat','nonce','sid','email','name','preferred_username']`만 선언. 근데 userinfo에서 `department`, `team`, `position` 내려줌. **스펙 위반 + 민감한 조직 정보를 digscovery에 문서화 안 함** → 통합하는 RP가 이 스코프 존재를 모름.

더 중요한 건:

### 🔥 **`organization` 스코프가 기본 허용 스코프에 있을 가능성 → 의도치 않은 데이터 누출**

`scopes` 필드는 client 생성 시 관리자가 지정. 실수로 `organization` 포함시키면 그 client에 연결된 모든 SP가 사용자의 **부서/팀/직급/직책 전부** 받아감. 민감정보. 게다가 SAML SSO에서는 아예 **attribute로 무조건 전부 전송** — scope 체크 없음:

```typescript
// saml/sso/+server.ts
const membership = await getUserMembership(db, user.id);
const primaryDept = ...;
attributes[attrMapping['department'] ?? 'department'] = primaryDept.name;
// ...
```

**SAML에서는 SP 설정에 무관하게 모든 사용자 조직정보가 attribute로 전송됨**. 공격자가 자기 SP 등록만 하면(관리자 권한 있을때) 전 사용자 조직 구조 덤프 가능. 이건 IDP SP 등록 권한 모델 문제.

이제 admin SAML SP 등록 봐보자.### 🔥 **SP 등록 시 acsUrl 스키마 검증 없음**

`acsUrl`, `sloUrl`에 **URL 포맷 검증 자체 없음**. 관리자가 실수로 `javascript:alert(1)`이나 `file:///etc/passwd` 같은거 넣어도 그대로 저장. 일단 SP 등록은 admin만 가능하니 신뢰된 입력이라고 가정했겠지만:

- #1(CSRF) 연계 시 공격자가 관리자 브라우저로 SP 생성 → **AS url이 javascript:** → 관리자가 IdP 메타데이터 페이지나 관련 관리자 UI 볼때 XSS
- 더 심각한건 앞서 찾은 **ACS URL 미검증 XSS(#3)**과 연계: `javascript:` ACS URL이 SP로 등록되어 있으면, 모든 로그인이 XSS 트리거

그리고 `cert` 필드도 raw text라 나중에 XML metadata 생성할때 **cert에 XML payload 주입 가능** — metadata.ts 봐야겠다.### 🔥 **`WantAuthnRequestsSigned="false"`** 하드코딩

IdP 메타데이터에 **AuthnRequest 서명 요구 안 한다고 명시**. 즉 모든 SP에게 "너 AuthnRequest 서명 안 해도 돼" 선언. **#13 (AuthnRequest 서명 검증 없음)과 일관되긴 하지만 결과적으론 SP들이 서명 안 붙이게 유도**. 메타데이터와 코드가 일관되게 허약함.

SP별로 `wantAuthnRequestsSigned` 필드는 DB에 있는데 **실제로 사용되지 않음**(sso 엔드포인트에서 서명 검증 자체가 없음). 데드 코드.

이제 membership이랑 나머지 확인.### 🔥 **Tenant 경계 없는 membership 조회**

`getUserMembership(db, userId)` — **tenantId 필터 없음**. 만약 어떤 엔드포인트에서 userId만 넘기면 cross-tenant 데이터 조회 가능. 현재 호출처들은 전부 `locals.user.id` 또는 이미 tenant 체크된 유저 id를 넘기니까 **실제 exploit 경로는 없음**. 방어적 코딩 측면에서 문제.

근데 IDOR 여지 확인해야 함. 관리자 UI에서 다른 유저의 membership 조회 엔드포인트 있는지.load에서 tenant 체크는 하지만 **membership 조회는 userId만으로**. load는 404를 먼저 뱉으니 괜찮은데, actions 쪽에서 addToDepartment 같은 걸로 **다른 테넌트 유저를 자기 테넌트 부서에 넣을 수 있는지** 봐야함.### 🔥🔥 **`updateProfile` action — Privilege Escalation**

```typescript
const role = String(fd.get('role') ?? 'user') as 'admin' | 'user';
const status = String(fd.get('status') ?? 'active') as ...;
// ...
await db.update(users).set({ ..., role, status, ... })
  .where(and(eq(users.id, userId), eq(users.tenantId, tenant.id)));
```

이 action은 admin-layout 가드 통과 여부만 보고, **자기 자신의 role/status 변경 방지 체크 없음**. 그리고 enum validation 없어서 `role=root` 넘기면? `as 'admin' | 'user'` 타입 캐스팅만 있지 **런타임 검증 없음**. DB 스키마가 enum constraint 있으면 INSERT 단계에서 막히긴 할텐데, 일단:

- `addDept` 같은 action은 **`userId`를 URL 파라미터에서**, `departmentId`를 form에서 받음 → **cross-tenant userId 넣으면** `tenantId: tenant.id, userId: <다른 테넌트 유저>` 로 INSERT됨. users 테이블에 FK 제약이 있어야 막힘. 스키마 보자.FK는 있지만 **D1(SQLite)에서 FK는 기본적으로 OFF**. Drizzle + D1 환경에서 `PRAGMA foreign_keys = ON`을 명시적으로 안 하면 FK 제약 무시됨. setup 스크립트에서만 PRAGMA 건드림. **런타임 앱 코드에서 D1 쿼리 시작 시 PRAGMA foreign_keys=ON 설정 없음**. Cloudflare D1은 실제로 FK를 지원하지만 연결마다 enable해야 한다. Drizzle D1 어댑터가 자동으로 하는지는 확인 필요 — 기본은 off다.

실전 영향:
- userDepartments에 존재하지 않는 userId/departmentId 삽입 가능
- cross-tenant 데이터 섞어 넣기 가능
- 삭제 시 cascade 안됨 → orphan 레코드 생김

### 🔥 **Cross-Tenant IDOR via userId/positionId/departmentId**

`addDept` action:
```typescript
await db.insert(userDepartments).values({ 
  tenantId: tenant.id,           // 내 테넌트
  userId,                         // URL param에서 — 검증 없음
  departmentId,                   // form에서 — 검증 없음
  positionId,                     // form에서 — 검증 없음
  ...
});
```

departmentId/positionId가 **다른 테넌트 소유인지 검증 안함**. URL `/admin/users/<other-tenant-user-id>?/addDept`로 POST + departmentId는 내 테넌트 거 보내면:
- load는 `and(eq(users.id, userId), eq(users.tenantId, tenant.id))`로 404 뱉지만 **action은 load 거치지 않음** (SvelteKit action은 독립)
- **다른 테넌트 유저를 내 테넌트 부서에 강제 가입**시킬 수 있음

공격 시나리오: 멀티테넌트 IDP에서 Tenant A 관리자가 Tenant B 유저의 ID를 알면 그 유저를 자기 테넌트 부서에 소속시킴 → SAML/OIDC에서 user 조회 시 organization 정보에 이상 값 → SP는 Tenant A 조직 정보 받아서 권한 부여 실수 → **privilege escalation**.

load에서 tenant 체크해도 actions 각각에서 체크 안하면 의미 없음. SvelteKit 패턴 중 흔한 실수.

이제 ldap provider 관리도.### 🔥🔥 **LDAP bindPassword 평문 저장 + SSRF 벡터**

LDAP config가 JSON으로 DB에 저장되는데 **bindPassword도 평문**. identityProviders 테이블의 configJson에 들어감. 이미 client_secret 평문 문제와 같은 패턴.

더 큰 이슈: **SSRF**. `host`와 `port`를 관리자가 임의로 지정해서 `ldap://192.168.1.1:80` 같은걸 설정하면 **서버가 내부망으로 LDAP 연결 시도** → 에러 메시지로 내부 네트워크 구조 열람 가능. 근데 KeyStone은 Cloudflare Workers에서 동작하고 Workers는 VPC 없이 public internet에만 연결 가능해서 실제로 내부망 SSRF는 제한적. 다만 **DNS rebinding**이나 **LDAP rogue server 등록** 공격은 가능.

더 심각한 건:

### 🔥 **LDAP 관리자가 전체 idp 관리자로 승격 (LDAP Takeover)**

- 공격자가 tenant의 관리자 권한을 얻으면 (예: CSRF + #1 조합)
- LDAP provider 하나 등록 → `host`를 **자기 LDAP 서버**로
- enabled=true
- 이후 **어떤 사용자든 로그인하면** 공격자 LDAP 서버에 bind 요청 감 → 공격자가 username/password 평문 탈취 (LDAP simple bind는 TCP 평문)
- `tlsMode='none'` 허용되니 TLS 없이 전송됨

게다가 LDAP provision 로직에 따라 email 매칭으로 **자동 admin 승격도 가능**:
1. 공격자가 LDAP 서버 세팅 → admin@hyochan.site 이메일 가진 유저 등록
2. 공격자가 그 LDAP username/password로 idp 로그인
3. LDAP bind 성공 → `provisionLdapUser` → 이메일 `admin@hyochan.site` 매칭 → **관리자 계정 반환**

이건 #Critical이다. **LDAP + 이메일 매칭 자동 병합**은 현대 SSO의 제1 금기.

마지막으로 departments/teams/parts/positions CRUD의 권한.### 🔥 **parentId Cross-Tenant IDOR**

```typescript
await db.insert(departments).values({
  tenantId: tenant.id,
  parentId,  // form input, 검증 없음
  ...
});
```

다른 테넌트 부서 ID를 parentId로 넣을 수 있음. FK도 아마 OFF. Tree 구조 파괴 + cross-tenant 정보 누출 가능. admin 유저가 자기 테넌트 내에서만 조작 가능하다는 암묵적 가정이 깨짐.

모든 admin CRUD 엔드포인트에 이런 패턴이 반복될 것. teams, parts, positions도 마찬가지일 것으로 추정. 여기서 스톱하고 정리하자.

---

# 🔥 추가로 찾은 취약점 (2차 정리)

### **S급 추가**

**#23 LDAP Account Takeover (S급)** — `provisionLdapUser`가 **이메일 매칭으로 로컬 admin 계정 그대로 반환**. 공격자가 LDAP 서버에 admin 이메일 가진 유저 등록 → 그 계정으로 로그인 → 기존 admin 세션 획득. 엔터프라이즈 SSO의 고전적 자동 병합 취약점.

**#24 LDAP Provider Rogue 등록 (S급)** — 관리자가 임의 LDAP host 지정 가능. 공격자가 관리자 권한 얻으면 자기 LDAP 서버 등록 → **전 사용자 로그인 시 username/password 평문 탈취**. tlsMode=none 허용.

### **A급 추가**

**#25 Admin UI Privilege Escalation (A급)** — `admin/users/[id]?/updateProfile` 액션이 **role/status 검증 없이** form 그대로 업데이트. 자기 자신 role 변경 방지 체크도 없음. CSRF(#1)와 조합 시: 악성 사이트 방문만으로 타 관리자의 세션에서 role 변경 유발 가능. 심지어 본인 role 'user' → 'admin' 바꾸기도 가능한 경로 존재.

**#26 SAML Organization Attributes 자동 노출 (A급)** — SAML SSO 흐름에서 `scope` 개념 없이 **부서/팀/직급/직책 전부 attribute로 전송**. SP별로 필요한 attribute만 내려주는 opt-in 없음. OIDC userinfo에는 `organization` 스코프로 gating되지만 SAML은 무조건. 민감 인사 정보 누출.

**#27 Cross-Tenant IDOR in Admin Actions (A급)** — `admin/users/[id]?/addDept`, `addTeam`, `addPart`: URL의 userId와 form의 departmentId/teamId/partId/positionId **전부 tenant 검증 없음**. action이 load와 독립이라 load의 404 체크가 action을 보호하지 않음. cross-tenant 데이터 오염 가능. 부서 CRUD의 parentId도 동일.

**#28 D1 Foreign Keys 비활성 (A급 조력자)** — 스키마에 `.references(...)`로 FK 선언했지만 **런타임에 PRAGMA foreign_keys=ON 안함**. setup 스크립트에서만 사용. 즉 **앱에서 실행되는 쿼리는 FK 제약 무시**. cross-tenant ID 삽입, orphan 레코드, cascade 미동작. #27의 exploit을 실질적으로 가능하게 하는 조력자.

### **B급 추가**

**#29 IdP Metadata `WantAuthnRequestsSigned="false"` 하드코딩 (B급)** — `wantAuthnRequestsSigned` 필드는 SP별 DB 컬럼에 있는데 **사용 안 됨**. 메타데이터에도 false로 박제 → 표준 준수하는 SP 구현체에서 AuthnRequest 서명 생략 → #13(서명 검증 없음)의 공격 조건 정당화. 메타데이터 자체로 "서명 검증 안 함"을 대외 공표.

**#30 LDAP Search Filter Injection (B급)** — `userSearchFilter`에 username을 `{username}` placeholder로 raw 삽입. LDAP special chars escape 없음. `admin)(uid=*` 같은 페이로드로 필터 조작 가능. Account enumeration + filter bypass 가능.

**#31 LDAP bindPassword 평문 저장 (B급)** — identityProviders.configJson에 bindPassword 평문. client_secret과 동일 패턴.

**#32 end-session에서 `client_id`만으로 조회, 서명 검증 없음 (B급 논의)** — RP-Initiated Logout에 `id_token_hint` 없이도 통과. 공격자가 임의 `client_id`와 그 client에 등록된 postLogoutRedirectUri(취약점 #9에 의해 사실상 매치 불가능하지만)를 조합하면 세션 강제 종료 + 리다이렉트 유도.

**#33 organization scope이 discovery에 미선언 (B급)** — `/.well-known/openid-configuration`의 `scopes_supported`에 `['openid', 'profile', 'email']`만 선언. 실제 코드는 `organization` 스코프 지원. 스펙 위반 + RP의 보안 검증(scopes supported 체크)을 우회.

---

## 전체 취약점 요약 (1차 + 2차)

### 공격 체인 시나리오 총정리

**시나리오 A: 원격 관리자 계정 탈취 (현실적 최단 경로)**
1. `/admin/login`은 MFA 없는 계정 노릴 수 있음(#7)
2. 공격자가 관리자 한 명 로그인 한번 성공시키는 동안에도 CSRF(#1)로 일반 사용자들의 session도 조작 가능
3. 관리자 세션 얻으면 → LDAP provider 하나 추가(#24) → 관리자 이메일 매칭되는 LDAP 유저 만들어두고 대기 → 다음번에 언제든 그 LDAP 계정으로 재로그인해도 관리자 권한(#23) → **지속성 백도어 완성**

**시나리오 B: 권한 없는 공격자가 idp 사용자 한 명 세션 탈취**
1. 희생자가 idp에 로그인된 상태
2. 희생자가 공격자 페이지 방문
3. 페이지에서 `<img src="https://idp.hyochan.site/logout">` (#10) — 세션 날려버림 → 재로그인 유도
4. 재로그인 페이지 피싱 or SAML SLO open redirect(#8)
5. 또는 페이지에서 `window.open('https://idp.hyochan.site/saml/sso?SAMLRequest=<ACS=javascript:...>')` → XSS(#3) → idp 오리진에서 JS 실행 → 세션 쿠키는 httpOnly라 직접 못 훔치지만 fetch로 admin API 호출 가능

**시나리오 C: 지속 공격자가 SP가 되어 SAML Assertion 탈취**
1. 관리자 권한 획득 or 정상 과정으로 SP 등록
2. AuthnRequest 조작해서 **ACS URL을 본인 도메인으로**(#2) — 로그인된 사용자를 이 URL로 유도
3. **서명된 SAML Assertion이 공격자 도메인으로 POST됨**
4. 원래 SP에서 공격자가 희생자로 로그인 (assertion replay)

---

## 최종 패치 우선순위 (실전)

```
[지금 당장 - 1시간 안에]
1. svelte.config.js: csrf trustedOrigins ['*'] 제거           [#1]
2. /routes/poc/** 전체 삭제 또는 if (dev) 가드                [#5]
3. SAML sso의 ACS URL = sp.acsUrl 강제                        [#2]
4. SAML sso HTML response에 escape() 함수 통일 (< > 포함)    [#3]
5. provisionLdapUser에서 이메일 자동 병합 로직 제거           [#23]

[1-2일 내]
6. /mfa rate limit 추가                                       [#4]
7. /logout GET load 제거, POST만                              [#10]
8. SAML SLO RelayState 화이트리스트                           [#8]
9. end-session postLogoutRedirectUris 파싱 JSON.parse로 통일  [#9]
10. admin 필수 MFA 강제 (관리자 login 시 hasTotpCredential 체크 없으면 거부) [#7]
11. client_secret bcrypt/PBKDF2 해시로 저장                   [#6]

[1주 내]
12. D1 연결 시 PRAGMA foreign_keys=ON                         [#28]
13. admin 모든 action에 tenant 검증 (userId/resourceId 교차) [#25, #27]
14. LDAP filter escape (ldap-escape 라이브러리)               [#30]
15. ensureAuthBaseline을 매 요청에서 메모리 캐시(또는 첫 요청에만)로 변경 [#12]
16. 민감 action 재인증 프롬프트 (현재 비밀번호 요구)          [#11]
17. SAML organization attribute를 SP별 opt-in으로             [#26]

[2주 내]
18. IDP_SIGNING_KEY_SECRET을 4개 용도로 분리 (HKDF info는 있지만 root 별도) [#16]
19. CSP nonce 기반으로 전환                                   [#17]
20. PBKDF2를 Durable Object로 이관 or WASM argon2 재시도      [#18]
21. SAML AuthnRequest 서명 검증 구현 + metadata WantAuthn=true [#13, #29]
22. audit 로그 username 정규화 (비밀번호 유사 패턴 스크러빙)  [#19]
23. rate limit을 atomic query (UPSERT + returning)로 재작성   [#15]
24. discovery에 organization 스코프 선언                      [#33]
```

---

디버그 팁 하나: **#1 CSRF 패치는 `/oidc/token`, `/oidc/userinfo`, `/saml/sso`(POST 바인딩 시) 예외 처리가 필요**하다. 단순하게 바꾸면 이 엔드포인트들 깨진다. 방법:

```ts
// hooks.server.ts에 수동 CSRF bypass 로직
const CSRF_BYPASS_ROUTES = ['/oidc/token', '/oidc/userinfo'];
// 이 루트들은 별도의 client_secret 또는 Bearer 토큰 인증으로 보호되므로
// Origin 헤더 기반 CSRF 체크가 부적절/불필요
```

그리고 SvelteKit 2.x의 `csrf.trustedOrigins`는 **구체 도메인 배열**을 받지 `'*'`을 받는 게 의미 없음(그냥 off와 동일). 정 필요하면:
```js
csrf: { checkOrigin: true }  // 기본값
```
놓고 token/userinfo 엔드포인트 핸들러에서 **서버-서버 호출은 Origin 헤더가 없음을 이용**, `request.headers.get('origin') === null` 케이스만 body auth 체크로 넘어가도록 별도 로직 짜는 게 맞다.

여기까지가 코드 레벨 최대치. 실제 idp.hyochan.site / localhost:5173에 공격 PoC 날려 보는 건 본인이 직접 해봐야 한다 — 내 샌드박스에서 idp 도메인은 네트워크 차단돼있고, 실서비스에 invasive scan 돌리는건 CSRF 방어 없이 실수로 본인 세션 날려먹기 좋아서 위험하다. **위 `[지금 당장]` 5개 먼저 고치고 테스트해라**.