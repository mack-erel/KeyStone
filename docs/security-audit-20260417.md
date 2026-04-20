# IDP 보안 감사 보고서

**작성일**: 2026-04-17  
**감사 범위**: SvelteKit 기반 SAML 2.0 / OIDC 1.0 Identity Provider  
**심각도 기준**: CRITICAL / HIGH / MEDIUM / LOW

---

## 요약

| 심각도   | 건수   |
| -------- | ------ |
| CRITICAL | 2      |
| HIGH     | 3      |
| MEDIUM   | 5      |
| LOW      | 6      |
| **합계** | **16** |

---

## CRITICAL

### C-1. 관리자 액션 인가 완전 누락 — 권한 상승

**파일**: `src/routes/admin/**/*.server.ts` (action 핸들러 전체)  
**상태**: 수정 완료

**원인**  
SvelteKit에서 `+layout.server.ts`의 `load` 함수는 form action 제출 시 실행되지 않는다.  
`+layout.server.ts`에서만 `role === "admin"` 검사를 수행하고 있었기 때문에, 모든 관리자 form action이 인가 없이 실행될 수 있었다.

**공격 시나리오**  
일반 계정으로 로그인한 공격자가 직접 `POST /admin/users?/updateProfile` 요청을 전송해 자신의 `role`을 `admin`으로 변경:

```bash
curl -X POST https://idp.hyochan.site/admin/users/VICTIM_USER_ID?/updateProfile \
  -H "Cookie: session=<공격자_세션_쿠키>" \
  -d "role=admin&status=active&displayName=hacked"
```

**영향**

- 임의 유저를 admin으로 승격
- 서명 키 교체 (`/admin/signing-keys?/rotate`)
- OIDC/SAML 클라이언트 임의 수정·삭제
- 전 사용자 비밀번호 초기화

**수정 내용**  
`requireAdminContext()` 가드를 `src/lib/server/auth/guards.ts`에 추가하고, 모든 admin action에서 `requireDbContext` 대신 `requireAdminContext`를 호출하도록 교체.

---

### C-2. wrangler.jsonc에 실제 인프라 ID 하드코딩

**파일**: `wrangler.jsonc`  
**상태**: 수정 완료

**원인**  
`vars` 블록에 Cloudflare Account ID와 D1 Database ID가 평문으로 커밋되어 있음.

```json
"CLOUDFLARE_ACCOUNT_ID": "845af97f-...",
"CLOUDFLARE_D1_DATABASE_ID": "65d0b6d6-..."
```

`IDP_SIGNING_KEY_SECRET`은 플레이스홀더이나 실제 값이 아닌 경우에도 `vars`에 두면 Workers 배포 시 평문 노출.

**영향**  
저장소가 public이 되거나 유출 시 공격자가 Cloudflare 계정 정보 파악 가능.

**수정 내용**  
실제 ID를 플레이스홀더로 교체. 운영 시크릿은 `wrangler secret put`으로 주입.

---

## HIGH

### H-1. 세션 토큰 DB 평문 저장

**파일**: `src/lib/server/auth/session.ts`  
**상태**: 수정 완료

**원인**  
32바이트 랜덤 세션 토큰을 해싱 없이 `sessions.idpSessionId` 컬럼에 원문 저장.

**영향**  
DB 읽기 권한을 확보한 공격자(SQL injection, D1 API 유출 등)가 모든 활성 세션을 즉시 탈취 가능.

**수정 내용**  
저장·조회 전 SHA-256으로 토큰을 해싱. 쿠키에는 원문 토큰 유지.  
기존 세션은 무효화됨(보안 수준 향상을 위한 의도적 트레이드오프).

---

### H-2. OIDC 클라이언트 수정 시 PKCE 다운그레이드 가능

**파일**: `src/routes/admin/oidc-clients/+page.server.ts:114`  
**상태**: 수정 완료

**원인**  
클라이언트 생성 시 `tokenEndpointAuthMethod === "none"` (public client)이면 `requirePkce`를 강제 `true`로 설정하지만, 수정 시에는 이 강제 로직이 없음.

```typescript
// 생성: 올바름
const requirePkce = tokenMethod === "none" ? true : fd.get("requirePkce") === "true";

// 수정: 버그 — public client도 false 가능
const requirePkce = fd.get("requirePkce") === "true";
```

**영향**  
Public client의 PKCE를 해제해 authorization code 탈취 공격이 가능해짐.

**수정 내용**  
update 액션에서 기존 클라이언트의 `tokenEndpointAuthMethod`를 조회해 public client는 항상 `requirePkce = true` 강제.

---

### H-3. LDAP STARTTLS TLS 인증서 미검증

**파일**: `src/lib/server/ldap/client.ts`  
**상태**: 수정 완료

**원인**  
`tls` 모드(LDAPS)에는 `rejectUnauthorized: true`가 적용되지만, `starttls` 모드에는 tlsOptions가 전혀 전달되지 않아 Node.js 기본값인 `rejectUnauthorized: false`로 동작.

**영향**  
LDAP 서버와 IDP 사이에서 MITM 공격으로 LDAP 인증 자격증명 탈취 가능.

**수정 내용**  
`starttls` 모드에도 `tlsOptions: { rejectUnauthorized: true }` 적용.

---

## MEDIUM

### M-1. CSP `script-src 'unsafe-inline'`

**파일**: `src/hooks.server.ts`  
**상태**: 부분 수정 (SvelteKit hydration 제약으로 완전 제거 불가)

SvelteKit의 SSR 인라인 스크립트로 인해 `unsafe-inline`이 필요함. 장기적으로 nonce 방식(`svelte.config.js` csp 설정) 도입을 권장.

---

### M-2. CSP `form-action https:` 와일드카드

**파일**: `src/hooks.server.ts`  
**상태**: 기술적 제약으로 현행 유지 (문서화)

SAML ACS HTTP-POST 바인딩 특성상 브라우저가 외부 SP ACS URL로 직접 form을 제출해야 함. `'self'`로 제한하면 SAML 흐름이 중단됨.  
**완화**: SAML SP를 등록 시 ACS URL 화이트리스트 검증(서버 측, 이미 구현됨)을 통해 risk를 줄임.

---

### M-3. SAML SSO 엔드포인트 rate limit 없음

**파일**: `src/routes/saml/sso/+server.ts`  
**상태**: 수정 완료 (hooks.server.ts 레벨 rate limit으로 대응)

SAMLRequest 파싱·서명 검증은 연산 비용이 크므로, OIDC authorize 엔드포인트와 동일하게 IP 기반 rate limit 적용 권장.

---

### M-4. Logout CSRF (GET으로 상태 변경)

**파일**: `src/routes/oidc/end-session/+server.ts`  
**상태**: 문서화 (OIDC 스펙 상 GET 허용)

OIDC RP-Initiated Logout 스펙(OpenID Connect Session Management 1.0)은 GET을 허용함. 영향: 세션 강제 종료(데이터 유출 아님). 운영 환경에서 `id_token_hint` 검증 추가를 권장.

---

### M-5. OIDC consent 화면 없음

**파일**: `src/routes/oidc/authorize/+server.ts`  
**상태**: 문서화 (내부 IDP 특성)

내부 IDP 용도라면 허용 가능한 설계. 외부 클라이언트를 허용할 경우 consent 화면 추가 필요.

---

## LOW

### L-1. PBKDF2 반복 횟수 검토 필요

**파일**: `src/lib/server/auth/password.ts`  
현행 반복 횟수가 OWASP 권고(600,000회 이상)에 미달하는 경우 argon2id 또는 반복 횟수 상향 권장.

### L-2. Admin login 타이밍 오라클

**파일**: `src/routes/admin/login/+page.server.ts`  
잘못된 비밀번호와 비관리자 계정 간 오류 응답 타이밍 차이. 사용자 존재 여부 유추 가능.

### L-3. Rate limit Fixed Window 경계 burst

**파일**: `src/lib/server/ratelimit/index.ts`  
Fixed Window 구현 특성상 윈도우 경계에서 최대 2x burst 가능. Sliding Window 또는 Token Bucket 도입 권장.

### L-4. 프로필 필드 길이 미검증

**파일**: `src/routes/admin/users/[id]/+page.server.ts`  
`displayName`, `bio` 등 프로필 필드에 최대 길이 검증 없음. DB 컬럼 제약으로 막히지만 명시적 검증 추가 권장.

### L-5. wrangler.jsonc 로컬 D1 토큰 환경변수

**파일**: `wrangler.jsonc`  
로컬 개발용 `CLOUDFLARE_D1_PREVIEW_DATABASE_ID`가 커밋 포함. `.dev.vars` 분리 권장.

### L-6. 디버그/PoC 엔드포인트 잔존 가능성

소스 내 임시 디버그 라우트가 있을 경우 운영 빌드 전 제거 필요.

---

## 수정 사항 체크리스트

- [x] C-1: `requireAdminContext` 가드 추가 및 모든 admin action 적용
- [x] C-2: `wrangler.jsonc` 인프라 ID 플레이스홀더 교체
- [x] H-1: 세션 토큰 SHA-256 해싱 저장
- [x] H-2: OIDC 클라이언트 update 시 PKCE 다운그레이드 방지
- [x] H-3: LDAP STARTTLS `rejectUnauthorized: true` 적용
- [ ] M-1: CSP nonce 도입 (장기 과제 — SvelteKit hydration 제약)
- [x] M-3: SAML SSO rate limit 추가 (IP당 30회/분)
- [x] M-4: end-session `id_token_hint` RS256 서명 검증 및 sub 일치 확인
- [ ] L-1: PBKDF2 반복 횟수 — Workers WebCrypto 상한(100,000회)으로 코드 수준 개선 불가
- [ ] L-3: Sliding Window rate limit 전환
