# IdP 프로젝트 킥오프

**작성일**: 2026-04-15
**상태**: In Progress (`M0` 완전 완료, `M1` OIDC 완전 완료, `M2` SAML 구현 완료, `M3` TOTP MFA 구현 완료)
**오너**: jang@hyochan.site

---

## 1. 프로젝트 개요

### 1.1 목적

사내·외 SP(Service Provider)에 대해 **단일 로그인(SSO)** 을 제공하는 자체 Identity Provider(IdP)를 구축한다.
1차 지원 프로토콜은 **SAML 2.0** 과 **OIDC (OpenID Connect 1.0)** 두 가지이며, 동일 사용자 디렉토리 위에서 두 프로토콜을 병행 서비스한다.

### 1.2 배경

- 현재는 SP 별로 로그인이 파편화되어 있어 계정 관리·감사·MFA 정책을 일관되게 적용하기 어렵다.
- 외부 SaaS는 SAML, 자체 개발 웹/모바일 앱은 OIDC를 선호하는 이분 상황이 있어 **둘 다 네이티브로 지원**하는 IdP가 필요하다.
- 상용 제품(Okta, Auth0 등) 도입 대비 요금·정책 커스터마이즈·데이터 주권 측면에서 자체 구축의 이득이 있다.

### 1.3 성공 기준 (MVP)

- [ ] 1명 이상의 실사용자가 SAML SP(예: Google Workspace 데모) 에 로그인 성공
- [ ] 1개 이상의 OIDC RP(예: 내부 대시보드) 에 `authorization_code + PKCE` 로그인 성공
- [ ] 관리자 UI에서 SP/RP 등록·수정·삭제 가능
- [ ] 감사 로그(로그인·발급·실패) 영속화 및 조회
- [x] `bun run lint`, `bun run check`, `bun run build` 통과
- [ ] Cloudflare Workers 프리뷰 배포 및 수동 검증

### 1.4 현재 구현 현황 (2026-04-16)

- [x] D1/Drizzle 스키마 정리 및 `users.role` 추가 마이그레이션 생성 (`drizzle/0001_flashy_blackheart.sql`)
- [x] `hooks.server.ts` 기반 인증 컨텍스트, `default` tenant bootstrap, bootstrap admin seed, 로그인/로그아웃, 세션 쿠키, 관리자 route guard 구현
- [x] 로그인/로그아웃/부트스트랩 이벤트 감사 로그 영속화 및 관리자 화면 조회 구현
- [x] 관리자 대시보드와 Users/OIDC Clients/SAML SPs/Signing Keys/Audit 페이지의 read-only 조회 구현
- [x] `users.username` 컬럼 추가 (`drizzle/0002_dizzy_korvac.sql`), 로그인을 이메일 대신 아이디(username)로 변경. `IDP_BOOTSTRAP_ADMIN_USERNAME` 미설정 시 email 로컬파트 자동 사용.
- [x] D1 마이그레이션 적용, bootstrap admin env 설정, `wrangler dev` 에서 아이디/비밀번호 로그인 수동 검증 완료
- [x] **M1 OIDC 완전 완료 (2026-04-16)**: `IDP_SIGNING_KEY_SECRET` 기반 RSA-2048 서명 키 자동 생성(`signing_keys` 테이블), `/.well-known/openid-configuration`, `/oidc/jwks`, `/oidc/authorize`(PKCE S256), `/oidc/token`(RS256 ID Token + HMAC-SHA256 opaque access token), `/oidc/userinfo`, `/oidc/end-session` 구현 및 수동 E2E 검증 완료.
- [x] **M2 SAML 완전 완료 (2026-04-16)**: `@peculiar/x509` X.509 cert 생성·저장(backfill 포함). `/saml/metadata`, `/saml/sso`(SP-Initiated, HTTP-Redirect→HTTP-POST), `/saml/slo` 구현. Cloudflare Access SAML SP 연동 수동 E2E 검증 완료 (`email` attribute 전달 확인). 서명 이슈 수정: xmldom `setIdAttribute` 등록, Response 컨텍스트 내 exc-c14n 서명.
- [x] **M3 TOTP MFA 구현 완료 (2026-04-16)**: RFC 6238 TOTP (WebCrypto HMAC-SHA-1, 30초, 6자리, ±1윈도우). 백업 코드 10개 생성·SHA-256 해시 저장·일회성 소진. MFA pending 쿠키(HMAC-서명, 5분 TTL). 로그인 TOTP 분기 → `/mfa` 검증 페이지. `/account/mfa` 등록·QR·백업코드 재생성·삭제 UI. 세션 `amr` 기록(`pwd`, `pwd totp`). 스키마 변경 없음(기존 credentials enum 활용).

---

## 2. 기술 스택 및 아키텍처

### 2.1 확정된 스택

| 영역            | 선택                                                     | 비고                                                   |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| Runtime         | Cloudflare Workers                                       | `wrangler.jsonc` 기반, `compatibility_date=2026-04-15` |
| Framework       | SvelteKit 2 + Svelte 5                                   | `@sveltejs/adapter-cloudflare`                         |
| Language        | TypeScript                                               | strict                                                 |
| DB              | **Cloudflare D1**                                        | Drizzle ORM (`drizzle-orm/d1`), Workers 바인딩         |
| Styling         | Tailwind CSS v4                                          |                                                        |
| i18n            | 메시지 카탈로그 기반 (e.g. `src/lib/i18n/{locale}.json`) | MVP: `ko` only. 로케일 감지 훅·`t()` 헬퍼 선제 도입    |
| Package Manager | bun                                                      |                                                        |

### 2.2 논의 필요 (결정 안 됨)

- ~~세션 스토어: D1 / KV / Durable Objects 중 택1~~ → **현재 `M0` 구현은 D1 `sessions` 테이블 + secure cookie 로 진행. 전역 일관성/SLO fan-out 이슈 때문에 Durable Objects 전환 여부는 `M3~M5` 에서 재검토. (2026-04-15 구현 기준)**
- **서명 키 저장**: Cloudflare Workers Secrets vs. R2 암호화 vs. 외부 KMS. JWK rotation 전략 포함.
- ~~MFA 범위~~ → **결정: TOTP + WebAuthn 둘 다 지원. 유저가 등록·선택 가능 (멀티 credential). 구현 순서는 TOTP → WebAuthn. (2026-04-15)**
- ~~디렉토리 소스: 외부 IdP federation 포함 여부~~ → **결정: MVP 는 자체 계정만 구현. 단, 스키마·모듈 경계는 3rd-party federation(Google/GitHub/기업 SAML IdP) 을 추후 무마이그레이션으로 얹을 수 있게 설계한다. (2026-04-15)**

### 2.3 초기 모듈 구조(안)

```
src/
  lib/server/
    auth/          # 세션·패스워드·MFA
    oidc/          # discovery, authorize, token, userinfo, jwks
    saml/          # metadata, SSO, SLO, assertion 서명/검증
    directory/     # user, group, credential, identity (federation-ready)
    federation/    # MVP 에선 local provider 만. oidc/saml/oauth2 어댑터 인터페이스 정의
    audit/         # 로그인·발급 이벤트
    crypto/        # 키 관리, JWK, X.509
    i18n/          # 로케일 감지, t() 헬퍼, 메시지 카탈로그. MVP: ko 만 존재.
    db/            # drizzle schema, migrations
  routes/
    (auth)/login, /logout, /mfa
    .well-known/openid-configuration    # MVP: default 테넌트 기준. 멀티 확장 시 /t/<slug>/.well-known/... 병행
    oidc/authorize, token, userinfo, jwks
    saml/metadata, sso, slo
    admin/*        # SP/RP/User 관리. 테넌트 스코프 미들웨어 경유.
    # 멀티테넌트 활성 시 경로 규칙(서브도메인 vs /t/<slug>)은 M?에서 확정
```

---

## 3. 프로토콜 범위 (MVP)

### 3.1 OIDC

- **지원 Flow**: `authorization_code` (+ PKCE 필수)
- **지원 Response Type**: `code`
- **ID Token 서명**: `RS256` (MVP), `ES256` 확장
- **엔드포인트**:
  - `/.well-known/openid-configuration` (Discovery)
  - `/oidc/authorize`
  - `/oidc/token`
  - `/oidc/userinfo`
  - `/oidc/jwks`
  - `/oidc/end-session` (RP-Initiated Logout)
- **제외(Out of Scope, MVP)**: implicit / hybrid flow, dynamic client registration, Request Object, FAPI

### 3.2 SAML 2.0

- **프로파일**: Web Browser SSO (SP-Initiated, IdP-Initiated 모두)
- **바인딩**: HTTP-Redirect(AuthnRequest), HTTP-POST(Response)
- **NameID**: `emailAddress`, `persistent`
- **서명**: `RSA-SHA256`, Assertion 서명 필수 / Response 서명 선택
- **암호화**: MVP 에선 선택(Off by default), 설정으로 on/off
- **엔드포인트**:
  - `/saml/metadata`
  - `/saml/sso` (AuthnRequest 수신)
  - `/saml/slo` (SingleLogout)

### 3.3 공통

- Consent 화면(1회 동의, 스킵 옵션)
- Attribute Release 정책 (SP/RP 별 claim/attribute mapping)

---

## 4. 데이터 모델 초안

```
tenants(id, slug, name, status, created_at, ...)
  # MVP 엔 seed 로 'default' 한 행만. 모든 하위 테이블은 tenant_id FK 보유.
users(id, tenant_id, email, role [admin|user], status, created_at, ...)  # (tenant_id, email) UNIQUE
credentials(id, user_id, type [password|totp|webauthn], secret, ...)
identities(id, tenant_id, user_id, provider [local|google|github|saml:<entity>], subject, email, raw_profile_json, linked_at, last_login_at)
  # local 포함 모든 인증 소스를 통일된 방식으로 관리. MVP 는 provider='local' 만 사용.
identity_providers(id, tenant_id, kind [oidc|saml|oauth2], name, client_id, client_secret_enc, discovery_url, scopes, enabled, ...)
  # MVP 에선 빈 테이블. federation 추가 시 행만 추가하면 활성화.
sessions(id, tenant_id, user_id, idp_session_id, expires_at, ip, ua, ...)
oidc_clients(id, tenant_id, client_id, client_secret_hash, redirect_uris, scopes, token_endpoint_auth_method, ...)
oidc_grants(id, tenant_id, client_id, user_id, code, code_challenge, redirect_uri, expires_at, used_at, ...)
oidc_refresh_tokens(id, tenant_id, client_id, user_id, token_hash, expires_at, revoked_at, ...)
saml_sps(id, tenant_id, entity_id, acs_url, slo_url, cert, name_id_format, sign_assertion, encrypt_assertion, ...)
saml_sessions(id, tenant_id, sp_id, user_id, session_index, not_on_or_after, ...)
signing_keys(id, tenant_id, kid, alg, public_jwk, private_jwk_encrypted, active, created_at, rotated_at)
  # 테넌트별 독립 키셋. MVP 는 default 테넌트 키 하나만.
audit_events(id, tenant_id, user_id, sp_or_client_id, kind, ip, ua, detail_json, created_at)
```

> 기존 `task` 테이블은 스캐폴딩 샘플이므로 제거 예정.

---

## 5. 보안 요건

- 모든 시크릿은 Wrangler Secret 또는 KMS 에 보관 (DB 원문 저장 금지)
- 패스워드: **MVP 는 `PBKDF2-SHA256 600k`**, `M5` 에서 `argon2id` 로 교체. `credentials.secret` 는 `pbkdf2$...` / `argon2id$...` prefix 로 알고리즘을 구분
- 서명키는 JWK 로 관리, `kid` 기반 rotation — 구 키는 유예기간 동안 검증에만 사용
- 세션 쿠키: `HttpOnly`, `SameSite=Lax`, HTTPS 에서 `Secure`
- CSRF: 로그인·consent 폼에 토큰 필수
- Clickjacking: `X-Frame-Options: DENY` / `frame-ancestors 'none'`
- XSS: SvelteKit 기본 escape + CSP 설정
- SAML: XML Signature Wrapping 대응, XXE 차단, 외부 엔티티 비허용 파서 사용
- OIDC: state/nonce/PKCE 필수 검증, redirect_uri 완전일치
- 레이트 리밋: 로그인 시도/토큰 엔드포인트 (KV 기반)
- 감사 로그: 로그인 성공·실패, 토큰 발급, 관리자 변경, 키 로테이션

---

## 6. 마일스톤

| #    | 이름            | 주요 산출물                                                  | 목표  |
| ---- | --------------- | ------------------------------------------------------------ | ----- |
| M0   | 셋업·기반       | 스키마, 세션, 로그인/로그아웃, 관리자 인증                   | 2주   |
| M1   | OIDC 최소       | discovery / authorize / token / userinfo / jwks, 1개 RP 연동 | 3주   |
| M2   | SAML 최소       | metadata / SSO / assertion 서명, 1개 SP 연동                 | 3주   |
| M3   | MFA(TOTP) + SLO | TOTP, 백업 코드, MFA 관리 UI, OIDC end-session, SAML SLO     | 2주   |
| M3.5 | MFA(WebAuthn)   | Passkey/보안키 등록·인증, username-less 로그인               | 1.5주 |
| M4   | 관리자 UI       | SP/RP/User/Key 관리, 감사 로그 뷰                            | 2주   |
| M5   | 강화            | 레이트리밋, CSP, 키 로테이션, 보안 점검                      | 2주   |

> 일정은 킥오프 시점 추정치이며 M1 완료 후 재조정.

### 진행 현황 (2026-04-16)

- `M0` 완전 완료. D1 마이그레이션 적용, bootstrap admin 계정 수동 로그인 검증까지 완료.
- `M1` 완전 완료 (2026-04-16). OIDC authorization_code + PKCE 전체 플로우, RS256 ID Token, HMAC opaque access token, userinfo, end-session 수동 E2E 검증 완료.
- `M2` 는 아직 미착수. SAML 을 위한 스키마, PoC 엔드포인트, 관리자 read-only 조회 기반은 준비됨.

---

## 7. 리스크 및 오픈 이슈

- **R1**: ~~Cloudflare Workers 환경의 Node 암호화 API 제약~~ → **PoC 결과: RS256 JWT 는 WebCrypto 로 OK. 패스워드 해시는 MVP 에서 PBKDF2-SHA256 600k 사용, M5 에서 argon2id(hash-wasm) 로 교체. `credentials.secret` 포맷에 알고리즘 prefix(`pbkdf2$...` / `argon2id$...`)를 포함하여 무중단 점진 교체. (2026-04-15 확정)**
- ~~**R2**: SAML XML 처리 라이브러리~~ → **`xmldsigjs + @xmldom/xmldom` 런타임 검증 완료 (2026-04-16). `verified: true`, RSA-SHA256 + exc-c14n 왕복 통과. Workers 에서 `setNodeDependencies({ DOMParser, XMLSerializer, xpath })` 필수. 확정.**
- **R3**: D1 의 쓰기 동시성·사이즈 한도(10GB/DB)·read replica 정책 모니터링 필요. 대규모 감사 로그는 별도 저장소(R2/Logpush) 분리 검토.
- **R4**: SSO 세션의 전역 일관성 — 현재 `M0` 는 D1 세션으로 구현. Workers 엣지 분산 특성상 DO 필요성은 계속 재검토.
- **R5**: 키 로테이션 UX — 활성 세션/발급 토큰 영향도.
- **R6**: 멀티 테넌트 활성화 시 테넌트 식별 방식(서브도메인 `tenant.idp.example.com` vs 경로 `/t/<slug>` vs 호스트 헤더)·JWT `iss` 규칙·관리자 권한 범위(글로벌 어드민 vs 테넌트 어드민) 재설계 포인트. MVP 에선 `iss` 를 고정값으로 두되 설정 가능하게.

### 오픈 질문 (결정 필요)

1. ~~DB 타겟을 libSQL 계속 갈지, D1 로 이관할지?~~ → **Cloudflare D1 사용 (2026-04-15 확정)**
2. ~~외부 IdP federation(Google/GitHub 로그인) 을 MVP 에 포함할지?~~ → **MVP 구현 제외. 단, 확장 가능한 구조로 설계 (2026-04-15 확정)**
3. ~~MFA 범위(TOTP 만 vs. WebAuthn 포함)?~~ → **둘 다. 유저별 복수 등록·선택 가능. TOTP 먼저 구현 (2026-04-15 확정)**
4. ~~멀티 테넌트(조직 단위) 설계를 1차에 반영할지?~~ → **MVP 는 단일 테넌트로 동작. 단, 스키마·라우팅·정책 레이어는 멀티 테넌트 확장을 전제로 설계. 기본 테넌트(`default`) 한 개로 시작. (2026-04-15 확정)**
5. ~~UI 언어 — 한국어 only / i18n?~~ → **i18n 구조로 구현. MVP 엔 한국어(`ko`) 로케일만 제공. 추후 로케일 추가는 메시지 파일만 얹으면 되도록 설계. (2026-04-15 확정)**

---

## 8. 다음 액션

- [x] 오픈 질문 1~5 의사결정
- [x] DB 스키마 드래프트 및 `M0` 용 마이그레이션 생성
- [x] `M0` 인증 기반 구현: 로그인/로그아웃, D1 세션, bootstrap admin seed, 관리자 보호, 감사 로그 조회
- [x] D1 에 마이그레이션 적용 (`0001_flashy_blackheart.sql`, `0002_dizzy_korvac.sql`)
- [x] `IDP_BOOTSTRAP_ADMIN_EMAIL`, `IDP_BOOTSTRAP_ADMIN_PASSWORD`, `IDP_BOOTSTRAP_ADMIN_USERNAME` 설정 후 수동 로그인 검증 완료
- [x] OIDC Discovery·JWKS 스캐폴드 → **완료 (2026-04-16)**
- [x] OIDC `authorize/token/userinfo/end-session` 최소 플로우 구현 → **완료 (2026-04-16)**
- [ ] SAML Metadata 스캐폴드 및 SSO 최소 플로우 구현 (M2)
- [ ] 관리자 UI 등록/수정/삭제(CUD) 구현
