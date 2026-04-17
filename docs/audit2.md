남은거 더 파볼게. 아직 WebAuthn, audit, 관리자 CRUD, signing key 관리, 조직 CRUD 엔드포인트 등 많이 남았다.WebAuthn 자체 구현체 보자. SimpleWebAuthn 안 쓰고 자체 구현 같은데?### 🔥 WebAuthn 치명적 문제 3개

**1. 테넌트 bypass via WebAuthn discoverable login**

`verifyPasskeyAuthentication`:

```typescript
const [cred] = await db
	.select()
	.from(credentials)
	.where(and(eq(credentials.credentialId, credentialId), eq(credentials.type, 'webauthn')))
	.limit(1);
```

**테넌트 필터 없음**. credential_id는 전역 유니크가 아닐 수 있음. 멀티테넌트인데 tenant 경계 안 걸고 credentialId 하나만 매칭. 그 후 `verify` 엔드포인트에서:

```typescript
if (user.tenantId !== tenant.id) {
	throw error(403, '접근 권한이 없습니다.');
}
```

아... 여기서 뒤늦게 체크는 함. 근데 공격 시나리오: 테넌트 A의 사용자 credential로 **테넌트 B의 도메인**에서 인증 시도 → 403 떨어짐. 직접적인 우회는 안되지만 credentialId를 통한 **테넌트 열거** 가능. 403 vs 400 응답 차이로 "이 credential은 다른 테넌트에 등록됨"을 알 수 있음.

더 큰 문제: 만약 **같은 서비스에서 subdomain 기반 테넌트**라면 rpID가 `idp.hyochan.site` 전체일때 서로 교차 인증 가능.

**2. WebAuthn 인증 엔드포인트 rate limit 없음**

`/api/webauthn/authenticate/verify` — rate limit 0. 서명 검증 실패는 WebAuthn spec상 거의 일어날 일이 없지만, **challenge cookie를 탈취한 공격자가 대량 요청 가능**. 실제로는 WebAuthn의 암호학적 결합 때문에 brute force는 어렵지만 DoS는 쉽다.

**3. `residentKey: 'required'` + discoverable login에서 username enumeration**

WebAuthn authenticate options를 allowCredentials 없이 만들기 때문에 discoverable 방식. 서버는 credentialId만 받아서 유저를 역조회함. 근데 위에서 본대로 `credentialId`만으로 find → **user 존재 여부가 응답 타이밍으로 누출**.

- 유효한 credentialId → DB hit → 서명 검증 실패 → 400
- 무효한 credentialId → DB miss → null return → 400 ("패스키 인증에 실패")

메시지가 같아서 구분 어렵지만 **DB query 타이밍 차이**로 구분 가능.

---

이제 audit 로그랑 관리자 CRUD 엔드포인트 보자. 관리자 페이지에서 사용자 생성 시 이메일/username 검증, SQL injection 여부.Drizzle ORM 써서 SQL injection은 안전함. 하지만 **비밀번호 정책 너무 약함** — `length >= 8`만. 복잡도 요구 없음. 근데 이건 UX 영향 크니까 스쿱 밖.

더 큰 이슈 발견:

### 🔥 **CSRF 방어 부재 가능성**

SvelteKit은 기본 origin 검증(`checkOrigin`)이 있는데, **`vite.config.ts`/`svelte.config.js`에서 이걸 꺼뒀을 수 있음**. 봐보자.---

# 🔥🔥🔥 **이게 진짜 Critical 중의 Critical**

### `csrf: { trustedOrigins: ['*'] }` — CSRF 방어 완전 비활성화

**모든 오리진에서 오는 cross-origin POST 요청을 전부 신뢰**한다. 주석에 "OIDC token endpoint 때문"이라고 써있지만 이건 틀린 접근:

- OIDC token 엔드포인트는 **client secret 기반 인증**이라 그 자체로 CSRF 안전
- CSRF 보호가 필요한 건 **쿠키 기반 세션을 쓰는 모든 admin 라우트, /login, /mfa, /account/\***
- 지금 설정으로는 공격자가 만든 페이지에서 `fetch('https://idp.hyochan.site/admin/users?/create', {method: 'POST', credentials: 'include', body: formData})` 때리면 그대로 실행됨

공격 시나리오:

1. 관리자가 idp.hyochan.site에 로그인된 상태로 `evil.com/cute-cat.html` 방문
2. evil.com에서 숨은 form으로 `POST /admin/users?/create`에 `email=attacker@evil.com&password=p&role=admin` 전송
3. 세션 쿠키는 `sameSite: 'lax'`라 **GET엔 붙지만 POST폼은 top-level 내비게이션이어야 붙음**. Fetch CORS로 `credentials:'include'`는 Origin 헤더가 가서 SvelteKit이 차단해야 하는데 **trustedOrigins: ['*']로 무력화**. 다만 브라우저 CORS preflight에서 막힐수도. **`<form target="_blank" action="..." method="POST">` top-level 내비게이션**이면 `sameSite: 'lax'`를 우회해서 쿠키 붙음.
4. **결과: 공격자가 임의로 admin 유저 생성 → 그 계정으로 로그인 → 완전 장악**

SvelteKit 공식 마이그레이션 가이드는 `trustedOrigins`에 **구체 도메인 리스트**를 요구하지 `'*'`이 아니다. 주석에 "공식 마이그레이션 권장"이라 써있는데 **근거 없는 자기 합리화**다. OIDC token 엔드포인트 하나 예외 처리하려고 전체 CSRF 방어를 날린 건 완전히 트레이드오프 잘못 계산함.

**단일 수정으로 가장 큰 보안 개선**:

```js
csrf: {
  checkOrigin: true,  // 기본값
  // 또는 토큰 엔드포인트만 예외 처리:
  trustedOrigins: []
}
```

그리고 `/oidc/token`, `/oidc/userinfo` 같은 서버-서버 엔드포인트는 **POST 요청을 그대로 두되, handle hook에서 해당 경로만 origin 체크를 개별 skip**하면 됨. SvelteKit 2.x부터는 `handleFetch`에서 처리 가능.

---

이제 xml-setup / SAML parse 더 깊이, 그리고 관리자 signing-keys 엔드포인트 보자.이제 audit 로그랑 profile 엔드포인트, LDAP provision, membership 봐야할 마지막 것들. audit은 stored XSS 가능성.Svelte의 `{ expression }` 바인딩은 기본 escape라 XSS는 안전. audit 로그 detail은 `JSON.stringify`로 넣고 화면에서 `{formatDetail(...)}` 렌더링 → 안전.

### 근데 Audit 로그에 **민감 정보 누출 가능성** 발견

```typescript
await recordAuditEvent(db, {
  ...
  detail: { username }  // 로그인 실패 시
});
```

username은 유저 입력. 공격자가 username 필드에 **비밀번호를 실수로 넣거나**, 실제 공격 시나리오 — **credential stuffing 했을 때 공격자가 username 자리에 password 넣는 실수**가 audit 로그에 영구 저장. 관리자가 audit 보면 평문 비밀번호 가능성.

더 큰 이슈: **IP + userAgent + username**이 로그에 남는다. GDPR/개인정보 관점에서 보관 기한/익명화 정책 없음. 그리고 `detail`에 `{ password }`가 들어간 곳은 못봤으니 ok.

이제 프로덕션에 정말 `/poc/*`이 뜨는지 직접 확인해본다. live site에 GET 해보는건 괜찮음.아 fetch 권한 이슈. 사용자가 준 URL이니까 괜찮을텐데 — 다시 시도.내 샌드박스 네트워크 정책상 idp.hyochan.site는 화이트리스트에 없어서 실제 요청 못 날림 (`host_not_allowed`). GitHub, npm만 허용됨. 라이브 사이트에 직접 공격하는 건 본인이 직접 해야 한다. 근데 그래도 지금까지 찾은 vector로 충분히 심각. 남은 것들 마저 정리하자.### 🔥 **MFA delete에 재인증 없음**

`account/mfa?/delete` 액션 — POST만 하면 **즉시 TOTP와 백업 코드 모두 삭제**. 현재 패스워드 확인도, TOTP 코드 재입력도 없다.

시나리오: CSRF가 위에서 본대로 막혀있지 않으므로(`trustedOrigins: ['*']`) + sameSite=lax + top-level 내비게이션. 공격자가 희생자한테 `evil.com` 링크 보내면 그 페이지에서 자동 POST로 **희생자의 MFA 완전 제거**. 그 다음 별도 공격으로 패스워드만 알아내면 뚫림.

비슷하게 `resetPassword`, `regenerate`(백업코드 재생성) 다 **현재 비밀번호 확인 없이 수행**. 재인증 프롬프트는 sensitive action의 기본.

### 🔥 **TOTP setup 쿠키 쌓기 가능**

`createSetupToken`은 HMAC 서명 쿠키에 플레인 TOTP 시크릿을 싣는다. 서버 상태 없이. 이론상 이 쿠키를 여러 개 발행 받아놓고 재사용 가능. 그리고 시크릿 자체가 HMAC 서명만 있고 **암호화 안됨** — base64url 디코딩하면 누구나 읽을 수 있음. 쿠키는 httpOnly + secure이지만 **서버 로그/프록시 로그에 쿠키값 찍히면 TOTP 시크릿 유출**. 실제 피해 조건은 서버 측 로깅 불이행이라 medium-low.

이제 마지막으로 시드 데이터, bootstrap 확인.### 🔥 **`ensureAuthBaseline`이 매 요청마다 실행됨**

`hooks.server.ts`에서:

```typescript
event.locals.tenant = await ensureAuthBaseline(db, event.platform);
```

매 요청마다 DB를 건드려서 tenant 존재 확인 + bootstrap admin 재확인 + signing key 재확인. 요청당 **최소 3~4 DB 쿼리 추가**. D1은 region 기반이라 latency도 있음. **인증 안된 요청에도 이 오버헤드**. 공격자가 `/any-route`를 대량으로 치면 D1 read quota 빠르게 소진. DoS 벡터 + 비용 공격.

게다가 bootstrap admin 로직에서 `IDP_BOOTSTRAP_ADMIN_EMAIL`+`PASSWORD`가 env에 남아있으면 **매 요청마다 findUserByEmail → findPasswordCredential → update 가능성**. 이건 별도 idempotency 처리돼 있긴 한데 read 쿼리는 계속 날라감.

README에도 "배포 후에는 관리자 UI에서 비밀번호를 변경하거나 해당 환경변수를 제거하는 것을 권장"이라고 써있는데, **제거 안 한 경우 보안 위험 + 비용 위험 둘 다**. 관리자가 UI에서 비밀번호 바꿔도 bootstrap env의 원래 비밀번호는 **계속 DB에서 등장할 기회는 없음**(existingUser 있으면 passwordCredential이 있으니 skip). 근데 관리자가 **비밀번호를 지우면** bootstrap이 원래 env 비밀번호를 다시 setpasswd — `!passwordCredential` 조건. 즉 admin이 자기 패스워드 삭제했을때 bootstrap env의 원래 비번으로 복구. 엣지케이스지만 백도어 효과.

---

마지막으로 logout과 end-session 쪽 세션 fixation이나 CSRF 정리.### 🔥 **GET /logout으로 CSRF 로그아웃 가능**

`load` 함수에 `performLogout` — 즉 **GET 요청으로도 로그아웃됨**. 공격자가 `<img src="https://idp.hyochan.site/logout">`를 자기 사이트에 심으면 idp에 로그인된 희생자가 그 페이지만 봐도 로그아웃됨. SameSite=lax라 GET에 쿠키 붙음.

DoS/nuisance 레벨이지만, **SAML/OIDC 플로우 한가운데서 로그아웃 터지면 공격 루틴 짤 수 있음**. 예: 희생자가 SAML SSO 플로우 시작 → 공격자 페이지 잠깐 경유 → `/logout` 트리거 → 희생자 다시 로그인 페이지 → 피싱 유도.

**세션 로그아웃은 반드시 POST여야 함.** `load`에서 수행하면 안됨.

---

## 이제 정리된 전체 취약점 추가분

### 🔥🔥🔥 **S급 (서비스 장악)**

| #   | 위치                  | 이슈                                                                  |
| --- | --------------------- | --------------------------------------------------------------------- |
| 1   | `svelte.config.js`    | **`csrf: trustedOrigins: ['*']`** — 전 라우트 CSRF 방어 완전 비활성화 |
| 2   | `saml/sso/+server.ts` | **ACS URL 미검증** — 서명된 SAML Response 공격자 서버로 POST          |
| 3   | `saml/sso/+server.ts` | **ACS URL HTML/URL context XSS** — idp 도메인에서 JS 실행             |

### 🔥🔥 **A급 (권한 탈취/우회)**

| #   | 위치                         | 이슈                                                               |
| --- | ---------------------------- | ------------------------------------------------------------------ |
| 4   | `(auth)/mfa/+page.server.ts` | **MFA brute force 가능** — rate limit 부재, 5분 재사용 토큰        |
| 5   | `routes/poc/*`               | **인증 없는 고비용 엔드포인트 3개 프로덕션 노출** — DoS + 비용폭탄 |
| 6   | `oidc/client.ts`             | **client_secret 평문 저장** — DB 유출 시 전 클라이언트 장악        |
| 7   | `admin/login`                | **관리자 MFA 강제 없음** + rate limit 20회/15분 합산 가능          |

### 🔥 **B급 (실제 공격 조건부)**

| #   | 위치                                             | 이슈                                                                            |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| 8   | `saml/slo/+server.ts`                            | **Open Redirect** — RelayState로 피싱                                           |
| 9   | `oidc/end-session/+server.ts`                    | **postLogoutRedirectUris 파싱 불일치 버그** — 정상 매치 실패 + 엣지 우회 가능성 |
| 10  | `(auth)/logout/+page.server.ts`                  | **GET /logout으로 CSRF 로그아웃**                                               |
| 11  | `account/mfa?/delete`, `account/mfa?/regenerate` | **민감 동작에 재인증 없음** — CSRF(#1) 연계 시 MFA 박탈                         |
| 12  | `hooks.server.ts`                                | **매 요청마다 `ensureAuthBaseline` 3~4 쿼리** — D1 quota/비용 DoS               |
| 13  | `saml/sso`                                       | **AuthnRequest 서명 검증 없음** — SP의 인가 요구 무력화, #2와 연계              |
| 14  | `webauthn.ts`                                    | **credential_id 전역 조회** — 테넌트 경계 약화, 유저 존재 여부 타이밍 누출      |
| 15  | `ratelimit/index.ts`                             | **SELECT→UPDATE non-atomic** — 고속 브루트포스 완화 무력                        |
| 16  | `auth/mfa.ts` + `totp.ts` + `keys.ts`            | **단일 `IDP_SIGNING_KEY_SECRET`이 4개 용도 공유** — root 유출 시 전체 붕괴      |

### 🟡 **C급 (하드닝)**

| #   | 위치                  | 이슈                                                                        |
| --- | --------------------- | --------------------------------------------------------------------------- |
| 17  | `hooks.server.ts` CSP | **`script-src 'unsafe-inline'`** XSS 방어 약화                              |
| 18  | `auth/password.ts`    | PBKDF2 100k iter — OWASP 권장 1/6                                           |
| 19  | `audit/index.ts`      | **username 로그 저장** — 공격자가 user 칸에 password 실수 입력 시 평문 기록 |
| 20  | `account/mfa?/create` | TOTP setup 쿠키에 base32 시크릿 HMAC만 서명, **암호화 안됨**                |
| 21  | `bootstrap.ts`        | **ADMIN env 제거 안 하면 비밀번호 삭제 시 자동 복구 가능** (엣지)           |
| 22  | 관리자 비밀번호 정책  | 8자 이상 외 복잡도/재사용/사전 단어 검사 없음                               |

---

## 실용적 공격 체인 (희생자 = 관리자)

1. **1단계 (정찰)**: `/.well-known/openid-configuration`, `/saml/metadata` → IDP 구성 파악. `/poc/rs256` 호출로 엔드포인트 존재 확인
2. **2단계 (초기 접근)**: 관리자가 방문할만한 링크로 유도
   - `evil.com`에 숨은 폼 `action=https://idp.hyochan.site/admin/users?/create method=POST`
   - Form은 top-level submit (sameSite=lax 통과) + **CSRF 방어 없음(#1)** → 공격자 계정 생성 성공
3. **3단계 (대안)**: 관리자 세션이 있으면 `saml/sso?SAMLRequest=<ACS=javascript:...>` URL 방문 유도 → **XSS(#3)** → 관리자 세션으로 직접 API 조작
4. **4단계 (지속성)**: 생성된 공격자 admin 계정으로 로그인 → signing key 회전 → **이후 발급되는 모든 ID Token/SAML Assertion을 공격자가 서명**

이 체인은 **#1 하나만 막혀있었어도 통째로 무너진다**. CSRF 방어가 진짜 최우선 수정 대상이다.

## 딱 3개만 고쳐도 체감

```js
// 1. svelte.config.js — 한 줄 수정
kit: {
  csrf: { checkOrigin: true },  // trustedOrigins: ['*'] 제거
}
```

```ts
// 2. src/routes/saml/sso/+server.ts — ACS 검증
const requestedAcs = authnRequest.acsUrl;
if (requestedAcs && requestedAcs !== sp.acsUrl) {
	throw error(400, 'AssertionConsumerServiceURL mismatch');
}
const acsUrl = sp.acsUrl; // DB 값만 사용
```

```ts
// 3. src/routes/(auth)/mfa/+page.server.ts — rate limit 추가
const rlKey = `mfa:${requestMetadata.ip ?? 'unknown'}:${claims.userId}`;
const rl = await checkRateLimit(db, rlKey, { windowMs: 15 * 60 * 1000, limit: 5 });
if (!rl.allowed) return fail(429, {...});
```

그리고 **`/routes/poc/` 전체 삭제 or 환경변수 가드**:

```ts
import { dev } from '$app/environment';
export const GET = async () => {
	if (!dev) throw error(404);
	// ...
};
```

이 4개가 지금 당장 패치 급. 나머지는 주 단위로 잡아가면 된다. 만약 라이브에서 PoC 직접 돌려보고 싶으면 본인 테넌트/본인 관리자 계정으로만 해라 — #1 CSRF만으로도 실수로 자기 세션 다 날아갈 수 있다.
