# 보안 설계 변경 필요 항목

코드 수준 패치로는 해결이 어렵고, 설계 결정이 필요한 항목들입니다.

## 완료된 항목

| # | 항목 | 커밋 |
|---|------|------|
| 5 | rate limit SELECT→UPDATE non-atomic | `INSERT … ON CONFLICT DO UPDATE … RETURNING` 원자적 처리로 교체 |
| 6 | D1 Foreign Keys 런타임 비활성 | `getDb()` async화 + `PRAGMA foreign_keys = ON` 추가 |
| 9 | OIDC `organization` scope discovery 미선언 | `scopes_supported` / `claims_supported` 에 추가 |
| 14 | OIDC `/authorize` rate limit 부재 | IP당 60회/분 rate limit 추가 |
| - | bootstrap admin env 백도어 | env 변수 제거, `setup.ts` → D1 직접 삽입 방식으로 전환 |

---

## 남은 항목

### 1. `ensureAuthBaseline` 매 요청마다 실행 — D1 quota/비용 DoS

**위치**: `src/hooks.server.ts`

**문제**
모든 요청(비인증 포함)마다 tenant 확인 + signing key 확인을 위해 D1 쿼리를 2회 실행한다. 공격자가 임의 경로를 대량 호출하면 D1 read quota 소진 및 요금 DoS가 가능하다.

**설계 방향**
- Workers `globalThis`로 tenant/signing key를 TTL 기반 인메모리 캐싱 (cold start 1회 후 재사용)
- `/.well-known/*`, `/api/health` 등 비인증 경로는 baseline 체크 skip

---

### 2. WebAuthn credential_id 전역 조회 — 테넌트 경계 약화 + 타이밍 열거

**위치**: `src/lib/server/auth/webauthn.ts` (`verifyPasskeyAuthentication`)

**문제**
credential 조회 시 `tenantId` 필터 없음. 테넌트 A의 credential_id로 테넌트 B 인증 시도 시 뒤늦은 `user.tenantId !== tenant.id` 체크로 403 반환 → 응답 타이밍 차이로 credential 존재 여부 열거 가능.

멀티테넌트 환경에서 rpID가 동일한 경우(`idp.hyochan.site` 전체), 테넌트 간 교차 인증 가능성이 이론상 존재한다.

**설계 방향**
- Option A: allowCredentials를 서버에서 미리 조회해 내려주는 방식으로 변경 (non-discoverable)
- Option B: credential 조회 쿼리에 `tenantId` 필터 추가 + rpID에 subdomain 포함 검토
- credential_id 조회 실패 시 constant-time dummy 검증으로 타이밍 누출 방지
- WebAuthn 인증 엔드포인트에 rate limit 추가

---

### 3. TOTP setup 쿠키에 시크릿 평문 포함 — 암호화 없음

**위치**: `src/routes/account/mfa/+page.server.ts` (`createSetupToken`)

**문제**
`idp_totp_setup` 쿠키는 `{ s: base32Secret, exp: ... }`를 base64url 인코딩 후 HMAC 서명만 붙임. 서버/프록시 로그에 쿠키값이 기록되면 TOTP 시크릿이 평문 노출된다.

**설계 방향**
- `createSetupToken`을 AES-GCM authenticated encryption으로 교체
- `IDP_SIGNING_KEY_SECRET`에서 HKDF로 별도 KEK 파생 (키 분리 원칙)
- 또는 DB에 임시 setup session 레코드 저장 + 쿠키에는 opaque session ID만 담는 방식

---

### 4. 단일 `IDP_SIGNING_KEY_SECRET`이 4개 용도를 공유

**위치**: `src/lib/server/auth/mfa.ts`, `src/lib/server/auth/totp.ts`, `src/lib/server/crypto/keys.ts`

**문제**
동일한 root secret을 4가지 용도로 사용한다:
1. private JWK 래핑 KEK
2. MFA pending 토큰 HMAC
3. access token HMAC
4. TOTP 시크릿 암호화 KEK

root secret 유출 시 전체가 동시에 붕괴된다.

**설계 방향**
- 환경변수 수준에서 용도별 분리: `IDP_JWK_WRAP_SECRET`, `IDP_TOKEN_HMAC_SECRET` 등
- 또는 단일 master key + HKDF context string으로 용도별 파생 키 분리 확인
- 키 로테이션 절차 문서화

---

### 7. SAML Organization Attributes 무조건 전송

**위치**: `src/routes/saml/sso/+server.ts`

**문제**
SAML SSO 흐름에서 SP 설정에 관계없이 부서/팀/직급/직책 등 조직 정보를 모든 attribute로 전송한다. SP 등록 관리자 권한만 있으면 전 사용자의 조직 구조를 덤프할 수 있다.

**설계 방향**
- SP별 허용 attribute 목록을 DB에 저장 (`allowedAttributes: ['email', 'username']`)
- SAML Response 생성 시 `sp.allowedAttributes` 기준으로 필터링
- 기본값: 최소 attribute (email, username)만, 조직 정보는 opt-in

---

### 8. IdP 메타데이터 `WantAuthnRequestsSigned="false"` 하드코딩

**위치**: `src/routes/saml/metadata/+server.ts`

**문제**
SP별 DB 컬럼 `wantAuthnRequestsSigned`는 존재하지만 미사용. 메타데이터에 항상 `false`로 공표해 서명 없는 AuthnRequest를 유도한다.

**설계 방향**
- `WantAuthnRequestsSigned` 속성을 SP별 또는 전역 설정으로 제어
- 장기적으로 AuthnRequest 서명 검증 로직 구현

---

### 10. WebAuthn Challenge 서버 측 Replay 방지 미구현

**위치**: `src/routes/api/webauthn/authenticate/verify/+server.ts`

**문제**
WebAuthn challenge가 HMAC 서명 쿠키로만 관리됨. 공격자가 쿠키값을 보유하면 5분 TTL 내 재사용 가능. WebAuthn 스펙은 challenge를 1회용 nonce로 요구한다.

**설계 방향**
- D1에 `webauthn_challenges` 테이블 추가 (challenge, expiresAt, usedAt) — options 발급 시 저장, verify 시 `usedAt` 마킹
- 또는 KV에 저장하고 verify 시 atomic 삭제
- 또는 `HMAC(sessionId + ts)` 기반으로 ts window 체크만으로 구현 (DB 불필요)

---

### 11. WebAuthn credentialId 단일 rpID 멀티테넌트 문제

**위치**: `src/lib/server/db/schema.ts`, `src/lib/server/auth/webauthn.ts`

**문제**
- credentialId가 전 테넌트에 globally unique 선언됨
- `url.hostname`을 rpID로 사용 → 모든 테넌트가 동일 rpID 공유
- 테넌트 A에 passkey 등록 시 테넌트 B에 같은 credentialId 재등록 불가

**설계 방향**
- Option A: 테넌트 per subdomain으로 rpID 분리 (`tenant-a.idp.example.com`)
- Option B: `credentialId` unique 제약을 `(credentialId, tenantId)` 복합으로 변경 + 조회 쿼리에 tenantId 필터 추가

---

### 12. Fork된 ldapjs + asn1 Supply Chain 리스크

**위치**: `package.json`

**문제**
`ldapjs: github:mack-erel/node-ldapjs`, `@ldapjs/asn1: github:mack-erel/asn1` — 공식 npm 대신 GitHub fork 직접 참조. fork 이유 미문서화, GitHub 계정 compromise 시 LDAP 인증 전체 경로에 악성 코드 주입 가능.

**설계 방향**
- fork 이유를 CLAUDE.md 또는 README에 명시 (Workers `net` 미지원으로 Cloudflare `connect()` API 사용)
- npm scoped package로 퍼블리시해 버전 고정 + integrity hash 확보
- 또는 upstream에 Workers 호환 PR 제출
- `bun.lock`에 integrity hash 포함 여부 확인

---

### 13. Audit 로그 Retention 정책 및 페이지네이션 미구현

**위치**: `src/lib/server/audit/index.ts`, audit 관련 admin 라우트

**문제**
- INSERT만 있고 purge/rotate 로직 없음 → D1 무료티어 5GB 한도 소진 가능
- audit 조회에 페이지네이션 없어 오래된 로그 접근 불가

**설계 방향**
- Cloudflare Cron Trigger로 90일 이상 로그 자동 purge
- audit 테이블에 `(tenantId, createdAt)` 복합 인덱스 추가
- cursor 기반 페이지네이션 도입
