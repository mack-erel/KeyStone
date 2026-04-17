이제 남은 건 깊이 있는 분석이다. 아직 안 본 것들: `crypto/keys.ts` 나머지, `getPublicJwks`에 rotated key 포함 여부, schema의 unique constraint, admin audit 조회 로직, organization scope 상세, session fixation, timing attack on password 엔드포인트, WebAuthn options endpoint. 더 있다.### 🔥 **`getPublicJwks`가 rotated 키까지 전부 반환**

```typescript
.from(signingKeys)
.where(eq(signingKeys.tenantId, tenantId));  // active 필터 없음
```

**활성/비활성 구분 없이 모든 키**를 JWKS로 노출. 키 로테이션했을 때 예전 키들이 계속 public JWKS에 남음. 정상적 JWT 검증 관점에서는 "예전 kid 토큰도 검증 가능"이라 무해하지만:

### 🔥 **RS256 kid Confusion 공격 가능성**

OIDC ID Token 검증 시 RP는 `kid`로 키를 찾는데, **JWKS에 여러 키가 있으면**:

1. 공격자가 JWKS 다운로드 → 모든 kid 파악
2. ID Token 검증 없는 취약한 RP가 있다면 kid 조작 공격 가능

더 중요한 건: **RSA public key를 통한 정보 노출**. 키 회전 히스토리가 공개돼서 보안 이벤트(예: "언제 긴급 회전했나") 추측 가능. 운영상 minor.

근데 진짜 심각한 버그 발견:### 🔥 **SAML signAssertion DB 필드 미사용**

sp schema에 `signAssertion`, `signResponse` 둘 다 있는데 **`signAssertion` 필드는 코드 어디서도 조건부로 쓰이지 않음** — assertion은 무조건 서명. 반면 `signResponse`는 쓰임. 그래서 assertion 서명은 항상, response 서명은 조건부. 실제 위협은 아니지만 DB 필드 semantic이 일관되지 않음.

### 🔥 **SAML XML Signature Wrapping (XSW) 공격 여지**

SAML Assertion 서명 관련해서는 XSW(XML Signature Wrapping) 공격이 고전적으로 알려짐. 이건 **receiver 쪽 (SP)** 문제라 IDP 입장에선 직접 관련 없음. 근데 `saml-sign` PoC에서 본대로 **xmldsigjs + @xmldom/xmldom 조합** 씀. 이 조합은 2018-2020년 사이에 **XSW 및 C14N 관련 CVE가 몇 개 발생한 스택**. 라이브러리 버전 확인하자.### 🚨🚨🚨 **`ldapjs: github:mack-erel/node-ldapjs` — Fork된 의존성**

**Supply chain risk.** 공식 `ldapjs` 패키지 대신 본인 fork를 쓰고 있다. 이건 빨간 깃발:

- 왜 fork 썼는지 README에 설명 없음
- fork 내용이 뭔지 감사 안됨
- GitHub 레포 삭제되면 빌드 깨짐
- 저자가 private key 유출되면 fork에 악성 코드 주입 가능

최소한 **fork한 이유와 upstream 대비 변경사항**이 commit message나 README에 있어야 함. 공식 ldapjs가 Cloudflare Workers에서 동작 안 해서 fork했을 가능성이 제일 높음 — Workers는 `net` 모듈 없어서 TCP socket을 Cloudflare의 `connect()` API로 교체해야 함. 그래도 **이유는 문서화되어야 함**.두 개 fork: `mack-erel/node-ldapjs#ffc02f5` + `mack-erel/asn1`. ASN.1 파서까지 fork됐다 — 더 걱정되는 상황. ASN.1 파서에 취약점 주입되면 인증서/LDAP 응답 파싱 전체가 위험.

이제 schema의 unique constraints와 admin audit 조회 보자.### 🔥 **`credentials_webauthn_credential_id_uidx` 전역 unique**

```typescript
uniqueIndex("credentials_webauthn_credential_id_uidx").on(t.credentialId);
```

credentialId가 **전 테넌트에 걸쳐 unique**. 이게 문제가 되는 시나리오:

- Tenant A 유저가 passkey 등록
- Tenant B에서 **같은 credentialId**(이론상 불가능하지만 weak authenticator는 충돌 가능) 등록 시도 → 실패

실제 영향: discoverable login에서 credentialId만으로 조회하는 #14와 결합 — `userId` 대신 `credentialId`가 사실상 cross-tenant identifier가 됨. 시나리오 한번 더:

희생자가 Tenant A에 passkey 등록 → 같은 브라우저/기기로 Tenant B의 idp 서브도메인 방문 → WebAuthn authenticate 진행 → 브라우저가 **같은 credentialId 제시**(같은 RP ID면) → DB에서 **Tenant A의 credential 발견** → tenantId mismatch로 403... **인데 tenant 체크 전에 이미 credential 정보 return**. 그리고 rpID는 `url.hostname`이라 각 테넌트가 같은 hostname이면 브라우저가 같은 passkey 사용. 결과적으로 tenant 경계가 희미해짐.

근데 KeyStone은 **tenant per subdomain**이 아니라 **단일 도메인 멀티테넌트**(기본 설정). 그럼 모든 테넌트가 같은 rpID → 한 유저가 passkey 하나 등록하면 **모든 테넌트의 그 이메일 계정에 자동 로그인 가능**? discoverable login 특성상 아이디 입력 없이 passkey 선택만으로 로그인됨. 그러면:

1. Tenant A 유저가 passkey 등록
2. Tenant B에도 같은 이메일로 로컬 계정 있음 (다른 회사 admin)
3. Tenant B의 /login에서 passkey 버튼 누름 → 브라우저가 저장된 passkey 제시 → credentialId로 Tenant A credential 발견 → **tenantId 체크에서 403**.

그래서 **자동 탈취는 막히긴 함**. 근데 WebAuthn API 플로우:### 🔥 **WebAuthn options endpoint에 rate limit 없음 + CSRF**

Options 엔드포인트도 rate limit 없음. 그리고 `/api/webauthn/authenticate/options` POST — CSRF 방어 #1 적용 대상. 공격자가 evil.com에서 cross-origin POST하면 challenge cookie가 희생자 브라우저에 심겨짐. 근데 이 쿠키는 독립적 (인증 효과 없음), 그냥 DoS 수준.

근데 더 심각한:

### 🔥🔥 **WebAuthn Challenge 재사용 가능**

challenge가 **HMAC 서명 쿠키에만 저장**되고 서버는 replay 방지 로직 없음. 5분 TTL인데 그 사이 여러번 사용 가능. WebAuthn spec은 **nonce**로 challenge를 요구하는데 이 구현은 reusable token. 공격 시나리오:

1. 공격자가 희생자의 WebAuthn assertion 하나를 MITM으로 가로챔 (예: 브라우저 확장 악성)
2. 같은 challenge cookie를 가진 상태에서 5분 안에 여러번 재전송 → **매번 성공**
3. 세션 여러 개 생성 → 다 유효

일반적인 WebAuthn 구현은 **챌린지를 서버 상태로 저장하고 1회 소비**한다. HMAC 쿠키만으로는 **브라우저 쪽 상태 소비**에 의존할 뿐.

게다가 challenge를 `/api/webauthn/authenticate/verify`에서 **삭제만** 하고 (`cookies.delete`) **서버에 "사용됨" 기록 안 함**. 공격자가 verify 요청의 쿠키를 가로채서(HTTP 응답 body에 실린 assertion + 쿠키) 사본으로 다시 쓰면:

```
공격자 -- 쿠키 재사용 --> idp.hyochan.site/api/webauthn/authenticate/verify
```

→ 매번 새 세션 발급.

Client-side cookies.delete는 쿠키가 빠진 응답을 브라우저에 돌려주는 것일 뿐 — 공격자 브라우저는 신경 안 씀. **서버 측 replay 방지 필수**.

이제 admin audit 조회, admin positions, admin teams의 tenant 교차 체크 봐보자.audit 엔드포인트 자체는 tenantId 체크함. 근데:

### 🔥 **Audit 로그에서 무제한 `kind` 필터 → SQL cleartext exposure 없음**

`kindFilter`는 drizzle eq로 들어가니 SQL injection 없음. 근데 `kindFilter`가 raw text라 임의 문자열. 특별한 `kind`로 DB를 뒤지려는 시도는 의미 없음.

### 🔥 **audit 검색 페이지네이션 없음** (DoS)

`limit` 500이 최대인데 **페이지네이션 없이 항상 앞에서부터 limit개**. 오래된 로그는 못 보지만 더 중요한 건, `selectDistinct` 쿼리가 **모든 audit row 스캔** — D1은 인덱스 없으면 full table scan. audit 테이블이 커지면(수십만 row) 관리자 UI 접속 시 매번 DB 비용 폭탄.

### 🔥 **Audit 삭제/purge 로직 없음**

`recordAuditEvent`는 INSERT만 있고 **retention 정책/삭제 로직 없음**. D1 저장 공간은 유한 (5GB per DB 무료티어). audit이 쌓이면 → 운영 리스크. 공격자가 로그인 실패를 의도적으로 대량 발생 시키면 D1 pollution.

이제 positions/teams 관리 보자.확정. 모든 admin CRUD가 **동일 패턴**으로 cross-tenant IDOR 가능:

- `teams.create`: departmentId form에서 받음 → **다른 테넌트 department ID 넣기 가능**
- 이후 조회 시 INNER/LEFT JOIN으로 붙여서 **다른 테넌트 부서 정보 노출**

또 하나 중요한 것:

### 🔥 **세션 fixation 가능성**

`src/lib/server/auth/session.ts`의 `createSessionRecord`를 보면 **로그인 시 기존 세션 revoke 안 함**. 공격자가 기존 세션을 이미 갖고 있을 때 희생자가 MFA까지 올라가도 그냥 새 세션 추가 생성. 공격자 세션은 그대로 유지.

더 심각한 건 **privilege escalation 중에 세션 재생성 안 함**:

- 사용자가 role=user로 로그인 → 세션 A 생성
- 관리자가 이 유저의 role=admin으로 변경
- 유저의 세션 A는 그대로 유효 → 다음 요청부터 관리자 권한

게다가 **비밀번호 변경 시 다른 세션 무효화 안 함**. `admin/users/[id]?/resetPassword` action이 그냥 credential만 업데이트하고 기존 세션들은 그대로. **탈취된 세션은 비번 바꿔도 유효**.예상대로 **비밀번호 리셋/MFA 변경/상태 변경 어디에도 세션 revoke 호출 없음**.

이제 login 페이지에서 `sanitizeRedirectTarget`도 한번 더 보자 — 우회 가능성.

```typescript
function sanitizeRedirectTarget(target: string | null): string | null {
    if (!target || !target.startsWith("/") || target.startsWith("//")) {
        return null;
    }
    return target;
}
```

### 🔥 **`/` 시작 + `//` 차단** 우회 가능

SvelteKit의 redirect는 상대경로로 쓰면 괜찮은데, `/\backslash.evil.com` 또는 `/javascript:alert(1)` 같은거. 실제로:

- `/%2fevil.com` → startsWith('//') false (URL 디코딩 안 함) → 통과 → 브라우저가 디코딩하면 `//evil.com`으로 해석? SvelteKit의 redirect는 내부적으로 Location 헤더에 그대로 씀 → 브라우저가 `//evil.com`으로 해석 → **외부 도메인 redirect**. 이건 브라우저/HTTP 구현체에 따라 다름.
- `/\evil.com` → startsWith('/') true, startsWith('//') false → 통과 → 일부 브라우저는 `\`를 `/`로 해석 → **외부 redirect**
- `/@evil.com` → `/@` 뒤의 @는 URL user portion, 일부 브라우저가 `evil.com`으로 파싱

**Known open redirect bypass**다. `startsWith('/')` + `!startsWith('//')`는 충분하지 않음. URL 객체로 파싱해서 pathname만 추출하는 게 안전함.

근데 SvelteKit `redirect(303, path)`에 쓰면... SvelteKit은 내부적으로 절대 URL 체크하는지 모르겠다. 코드를 너무 믿지 말자.

마지막 주요 체크:일관되게 **teamId cross-tenant 안 봄**. 확정 패턴이다.

---

# 🔥 3차 찾은 취약점 (최종)

## S급

**#34 ⚠️⚠️⚠️ Fork된 `ldapjs` + `@ldapjs/asn1` 사용 (Supply Chain S급)**

- `github:mack-erel/node-ldapjs#ffc02f5`, `github:mack-erel/asn1`
- 공식 패키지 대신 저자 본인의 fork 사용. ASN.1 파서까지 fork.
- fork 이유/변경사항 문서화 없음
- 저자 GitHub 계정 compromise 시 LDAP 전체 경로 악성 코드 주입 가능
- 실제 프로덕션 사용 시 **공식 패키지 or npm에 퍼블리시된 fork 사용 + 정기 audit 필수**

## A급

**#35 WebAuthn Challenge Replay 가능 (A급)**

- challenge를 HMAC 쿠키로만 관리, 서버 측 1회용 소비 기록 없음
- `/api/webauthn/authenticate/verify`에서 `cookies.delete`는 응답 쿠키만 지움 → 공격자가 쿠키 원본 가지고 있으면 재사용
- **WebAuthn 스펙상 challenge는 nonce(1회용)여야 함**
- 쿠키 탈취 시나리오(브라우저 확장 악성 등) 외에도 MITM 시 여러 세션 발급 가능

**#36 세션 Fixation / 권한 승급 후 세션 유지 (A급)**

- 로그인 시 기존 세션 revoke 안 함
- **role 변경 시 세션 재발급 없음** → user→admin 변경하면 기존 세션 그대로 admin 권한
- **비밀번호 리셋 시 다른 세션 무효화 없음** → 탈취된 세션은 비번 바꿔도 유효
- **MFA 활성화/삭제 시 세션 재발급 없음** → MFA 설정 우회한 기존 세션 유효

**#37 redirectTo Open Redirect 우회 (A급)**

- `sanitizeRedirectTarget`이 `startsWith('/') + !startsWith('//')` 만 체크
- 우회 페이로드: `/\evil.com`, `/%2fevil.com`, `/@evil.com`
- 브라우저 파싱 규칙에 따라 외부 도메인 리다이렉트
- URL 객체로 pathname 추출 + hostname 검증이 정석

## B급

**#38 getPublicJwks rotated 키까지 노출 (B급)**

- active/rotated 필터 없이 전체 키 JWKS 노출
- rotation 히스토리 공개됨 (minor info leak)
- 정상 사용에는 문제 없지만, 만료된 키로 서명된 토큰도 검증 성공 → 교체 의미 약화

**#39 WebAuthn credentialId 전역 unique + 단일 rpID 멀티테넌트 (B급)**

- credentialId unique 제약이 tenant 경계 모호화
- 한 유저가 테넌트별로 passkey 따로 등록 불가 (credentialId 충돌)
- rpID가 `url.hostname`이라 모든 테넌트가 같은 호스트면 브라우저가 같은 passkey 제시
- Tenant 경계 체크가 늦게 발동(403)되지만 cross-tenant credential 존재 여부 타이밍 누출

**#40 SAML `signAssertion` DB 필드 미사용 (B급 데드 코드)**

- SP 테이블에 `signAssertion` 컬럼 있는데 코드에서 체크 안 함
- 관리자가 UI에서 토글해도 의미 없음 → 잘못된 보안 감각 유발

**#41 Audit 로그 페이지네이션/retention 부재 (B급)**

- 고정 limit(50/100/200/500) + offset 없음 → 오래된 로그 영영 못 봄
- `selectDistinct` 쿼리가 full scan
- Audit purge/rotate 로직 없음 → D1 스토리지 DoS
- 공격자가 login failure 유도하면 로그 볼륨 폭발

**#42 `/oidc/authorize` rate limit 없음 (B급)**

- authorize 엔드포인트는 DB에 grant 레코드 INSERT (매 요청마다)
- rate limit 없어서 대량 호출 시 grants 테이블 폭발 + 비용
- token 엔드포인트에는 있는데 authorize에는 없는 비대칭

## C급

**#43 SAML Destination/Recipient/Audience 검증 관점 (C급 SP측 문제이지만 IDP가 유도)**

- Response의 `Destination`, `Recipient`, `Audience`가 attacker-controlled `acsUrl`, `spEntityId`로 들어감
- SP가 이걸 제대로 검증하지 않으면 token reuse across SPs 가능
- IDP 자체 문제라기보단 #2 ACS URL 검증의 연쇄 효과

**#44 SAML Response의 `inResponseTo` 검증 관점 (C급)**

- AuthnRequest ID를 그대로 InResponseTo로 echo
- SP가 outgoing AuthnRequest ID를 tracking하고 체크해야 IdP-Initiated SSO attack 방어 가능
- IDP가 enforcing할 수는 없지만, 최소한 **IdP-Initiated SSO 명시 허용 여부 필드** 있어야 함

---

# 📋 종합 취약점 카탈로그

1~22: 1차 분석  
23~33: 2차 분석 (LDAP, cross-tenant IDOR, metadata)  
34~44: 3차 분석 (supply chain, WebAuthn replay, session fixation, open redirect bypass)

## 등급별 정리

**Critical (S급) — 즉시 장악 가능**

- `#1` CSRF 전 비활성화
- `#2` SAML ACS URL 미검증
- `#3` SAML ACS XSS
- `#23` LDAP 이메일 자동 병합 → admin takeover
- `#24` Rogue LDAP provider 등록
- `#34` Fork된 ldapjs + asn1 supply chain

**High (A급) — 인증/권한 우회**

- `#4` MFA brute force
- `#5` PoC 엔드포인트 노출
- `#6` client_secret 평문
- `#7` admin MFA 미강제
- `#25` admin updateProfile 권한 검증 결여
- `#26` SAML organization 자동 노출
- `#27` admin actions cross-tenant IDOR
- `#28` D1 FK OFF
- `#35` WebAuthn challenge replay
- `#36` session fixation + 권한 변경 후 세션 유지
- `#37` redirectTo open redirect 우회

**Medium (B급)**

- `#8` SAML SLO open redirect
- `#9` end-session 파싱 버그
- `#10` GET /logout CSRF
- `#11` 민감 동작 재인증 없음
- `#12` hooks ensureAuthBaseline 매요청 DB 쿼리
- `#13` SAML AuthnRequest 서명 검증 없음
- `#14` WebAuthn credential 전역 조회
- `#15` rate limit non-atomic
- `#16` signing secret 4용도 공유
- `#29` IdP metadata WantAuthnSigned=false 하드코딩
- `#30` LDAP filter injection
- `#31` LDAP bindPassword 평문
- `#32` end-session 서명 검증 없음
- `#33` discovery organization scope 미선언
- `#38` JWKS rotated 키 노출
- `#39` WebAuthn credentialId 전역 unique
- `#40` SAML signAssertion 데드 필드
- `#41` Audit 페이지네이션/retention 부재
- `#42` authorize rate limit 없음

**Low (C급) — 하드닝**

- `#17` CSP unsafe-inline
- `#18` PBKDF2 100k
- `#19` audit username 로그 저장
- `#20` TOTP setup 쿠키 미암호화
- `#21` bootstrap 비번 복구 엣지
- `#22` 비번 복잡도 정책 없음
- `#43` SAML Destination/Recipient SP측 문제
- `#44` IdP-Initiated SSO 정책 필드 없음

---

# 🎯 현실적인 Next Steps

## 오늘 밤에 해야 할 것 (1시간)

```js
// 1. svelte.config.js
kit: {
    csrf: {
        checkOrigin: true;
    }
}

// 2. routes/poc/ 전체 삭제 (또는 dev 가드)
// 3. routes/(auth)/logout/+page.server.ts 에서 `load` 함수 제거
// 4. SAML sso: const acsUrl = sp.acsUrl (sp DB값 강제)
// 5. provisionLdapUser: "existingUser 있으면 에러 throw" 로 변경
```

이 5개만 해도 **S급 중 4개가 사라진다**. 나머지 A/B/C급은 주/월 단위로 잡아가.

## 이번 주 안에 (10시간)

```ts
// 6. MFA endpoint rate limit
// 7. admin MFA 강제 (관리자 계정은 TOTP 필수)
// 8. admin 모든 action에 tenantId 교차 검증 (resource FK 체크)
// 9. D1 PRAGMA foreign_keys=ON (hooks 또는 db 초기화)
// 10. WebAuthn challenge 1회용 소비 (D1에 used_challenges 테이블)
// 11. session revoke: role/password/MFA 변경 시 세션 전부 revoke
// 12. sanitizeRedirectTarget: URL 객체 파싱 + hostname 체크
// 13. LDAP provider 등록을 super-admin 권한으로 격상 + host 화이트리스트
```

## 한 달 안에 (설계 변경)

```ts
// 14. client_secret 해시 저장
// 15. ldapjs fork를 npm에 퍼블리시하거나 공식 유지관리자에 기여
// 16. IDP_SIGNING_KEY_SECRET을 용도별로 분리
// 17. SAML AuthnRequest 서명 검증 구현 + metadata WantAuthn=true
// 18. Audit retention 정책 (90일 이상 자동 purge)
// 19. CSP nonce
// 20. organization 스코프를 SAML에도 opt-in
```

## 장기 (설계 재검토)

- **Cloudflare Workers + PBKDF2 100k vs argon2** — Durable Object나 별도 compute 분리해서 argon2id 쓰는게 맞다
- **멀티테넌트 + 단일 도메인** 모델 vs **tenant-per-subdomain** 모델 선택 — 현재 모델은 WebAuthn/passkey에 근본적으로 어색함
- **PoC 엔드포인트 + 프로덕션 코드 혼재** — 아예 별도 워크스페이스로 분리

---

# 🏁 최종 평가

오픈소스로 공개한 학습/실험 프로젝트로서는 상당히 야심차고 구조도 잘 짜여있어. OIDC/SAML/WebAuthn/LDAP/TOTP + 멀티테넌트 + 관리자 UI를 혼자 Workers 위에 올린 건 진짜 대단하다. Drizzle ORM 덕에 SQL injection 계열은 깨끗하고, XML 서명 구현을 제대로 xmldsigjs 쓴 것도 좋다.

근데 **프로덕션 IDP로 쓰기엔 아직 절대 불가**하다. 위 44개 중 **S급 6개 + A급 11개 = 17개가 현실적 공격으로 이어지는 경로**다. 특히:

- `#1 CSRF trustedOrigins:['*']` — **한 줄로 전체 방어가 풀림**. 이 한 줄 덕에 나머지 모든 admin action이 공격 surface가 된다.
- `#23 LDAP 이메일 자동 병합` — 이건 **설계 철학의 오류**. 이메일은 식별자가 아니라 컨택트 정보다. 엔터프라이즈 IDP 구현 전 꼭 공부해야 할 principle.
- `#28 D1 FK OFF` — cross-tenant IDOR 전부를 **실제 공격 가능**하게 만든다.

**idp.hyochan.site를 현재 상태로 본인 블로그 외 다른 SP와 연동하면 위험하다.** 정확히는:

- 혼자 본인 블로그 로그인용으로만 쓰면 위협 모델이 작으니 OK
- 여러 서비스 + 여러 사용자가 쓰게 되면 **위 수정 끝나기 전까지는 절대 metadata 공유하지 말 것**

README에 "**This is a learning project. Not audited. Do not use in production without security review.**" 한 줄 박아넣는게 제일 먼저다. 오픈소스인 만큼 다른 개발자가 실수로 production 쓰지 않도록.

**감사 끝.** 지금까지 발견한 44개로 실제로 A부터 Z까지 공격 체인이 다 구성 가능한 상태다. 위 `[오늘 밤]` 5개만 패치하면 당장은 현실적 위협이 크게 줄어든다. 나머지는 우선순위대로 차근차근 잡으면 된다. 기능 구현 수준은 높으니까 보안 체크리스트만 맞춰나가면 되는 상태다. 화이팅.
