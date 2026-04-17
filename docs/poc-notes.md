# Workers 환경 PoC 노트

킥오프 M0 리스크 R1/R2 사전 검증.

## 범위

- `/poc/rs256` — RS256 JWT 서명/검증
- `/poc/argon2` — 패스워드 해시 가능성
- `/poc/saml-sign` — SAML Assertion 서명 가능성

## 결과 요약

| 항목                               | 상태                                | 비고                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RS256 JWT (WebCrypto)              | ✅ OK                               | 외부 의존성 없이 동작. OIDC ID Token 서명 그대로 사용 가능.                                                                                                                           |
| 패스워드 해시 (PBKDF2-SHA256 100k) | ✅ OK (`M0` 구현 반영 완료)         | WebCrypto 네이티브. Workers 런타임 PBKDF2 한도 100,000회 — 600k 는 런타임 오류 발생하여 100k 로 조정. `M5` 에서 argon2id 교체 예정.                                                   |
| SAML Assertion 서명                | ✅ OK (`2026-04-16`)                | `xmldsigjs + @xmldom/xmldom` 런타임 검증 완료. `verified: true`, 서명 46ms (keygen 43ms, sign 2ms, verify 1ms). `setNodeDependencies({ DOMParser, XMLSerializer, xpath })` 등록 필요. |
| 개발 체인 (`lint/check/build`)     | ✅ OK (`2026-04-16` 기준 검증 완료) | `wrangler types --check`, `svelte-check`, `vite build` 까지 통과.                                                                                                                     |
| M0 수동 로그인 검증                | ✅ OK (`2026-04-16`)                | D1 마이그레이션 적용, bootstrap admin 아이디/비밀번호 로그인 → `/admin` 리다이렉트 확인.                                                                                              |
| M1 OIDC E2E 검증                   | ✅ OK (`2026-04-16`)                | PKCE S256 authorize → token(RS256 ID Token + HMAC access token) → userinfo 전체 플로우 수동 검증 완료. `signing_keys` 자동 생성 확인.                                                 |

## 실구현 반영 상태 (2026-04-16)

- `PBKDF2-SHA256 600k` 결정은 실제 인증 모듈에 반영되었고, `credentials.secret` 포맷은 `pbkdf2$sha256:600000$<salt>$<hash>` 형태를 사용한다.
- `default` tenant bootstrap, bootstrap admin seed, 로그인/로그아웃, 세션 쿠키, 감사 로그 저장/조회까지 `M0` 범위로 구현되었다.
- 로그인 식별자를 이메일에서 **아이디(username)** 로 변경. `users.username` 컬럼 추가(`drizzle/0002_dizzy_korvac.sql`), bootstrap 시 `IDP_BOOTSTRAP_ADMIN_USERNAME` 미설정이면 email 로컬파트 자동 사용.
- D1 마이그레이션 적용 및 `wrangler dev` 환경에서 아이디/비밀번호 로그인 수동 검증 완료 (2026-04-16). **M0 완전 완료.**
- `IDP_SIGNING_KEY_SECRET` 설정 시 기동 시점에 `signing_keys` 테이블에 RSA-2048 키가 자동 생성되며, `/oidc/jwks` 공개 엔드포인트로 노출된다. AES-256-GCM(HKDF) 으로 private JWK 암호화 저장. **M1 완료.**
- **M2 SAML E2E 검증 완료 (2026-04-16)**: Cloudflare Access SAML SP 연동 수동 검증 완료. `/saml/metadata` cert 포함 정상 반환, SP-Initiated SSO → 로그인 → HTTP-POST Response → `email` attribute 전달 확인. 서명 이슈 2건 수정: ① xmldom `setIdAttribute('ID', true)` ② Response 문서 컨텍스트 내 서명(exc-c14n namespace 일치).

## 의사결정 기록

1. ~~패스워드 해시~~ → **확정 (2026-04-15, 수정 2026-04-16)**: MVP 는 **PBKDF2-SHA256 100k** (WebCrypto 네이티브, 번들 없음). Workers 런타임 한도로 600k → 100k 조정. M5 에서 **argon2id (`hash-wasm`)** 로 교체.
    - `credentials.secret` 포맷: `<algo>$<params>$<salt>$<hash>` — 예: `pbkdf2$sha256:100000$<salt_b64>$<hash_b64>` / `argon2id$m=65536,t=3,p=4$<salt_b64>$<hash_b64>`
    - 검증 시 prefix 파싱 → 알고리즘 분기. 교체 시 로그인 성공 순간 재해시하여 새 포맷으로 upgrade (무중단).
2. **SAML 서명 라이브러리**: `xmldsigjs + @xmldom/xmldom` 채택 후보 1순위. 번들 통과(2026-04-15). 런타임 검증 후 확정.

## 실구현 반영 상태 (2026-04-16, 추가)

- **M3 TOTP MFA 구현 완료 (2026-04-16)**:
    - `totp.ts`: RFC 6238 TOTP (WebCrypto HMAC-SHA-1), base32, ±1 윈도우 검증
    - `mfa.ts`: HMAC-서명 MFA pending 쿠키 (5분 TTL)
    - 로그인 플로우 TOTP 분기, `/mfa` 검증 페이지, `/account/mfa` 등록·관리 UI
    - 백업 코드 10개 생성·SHA-256 해시 저장, 일회성 소진
    - 세션 `amr` 컬럼 기록 (`pwd`, `pwd totp`, `pwd swk`)
    - `qrcode` 패키지 (클라이언트 사이드 QR 렌더링)
    - **스키마 변경 없음**: 기존 `credentials.type` enum(`totp`, `backup_code`) 그대로 활용

## 실구현 반영 상태 (2026-04-16, M3.5)

- **M3.5 WebAuthn/Passkey 구현 완료 (2026-04-16)**:
    - `@simplewebauthn/server v13` + `@simplewebauthn/browser v13` 채택. Workers WebCrypto 전용, 외부 의존성 없음.
    - `webauthn.ts`: HMAC-서명 챌린지 쿠키(5분 TTL), `buildRegistrationOptions`, `savePasskey`, `buildAuthenticationOptions`, `verifyPasskeyAuthentication`
    - `residentKey: 'required'` → discoverable credential (username-less 로그인)
    - API 라우트 4개: `/api/webauthn/register/options`, `/api/webauthn/register/verify`, `/api/webauthn/authenticate/options`, `/api/webauthn/authenticate/verify`
    - `/account/passkeys` 페이지: passkey 목록·등록·삭제 UI (클라이언트 사이드 `@simplewebauthn/browser` dynamic import)
    - 로그인 페이지에 "패스키로 로그인" 버튼 추가 (password-less 플로우)
    - 세션 `amr: ['hwk']` (RFC 8176 hardware key)
    - `bun run check && bun run build` 통과 확인

## 다음 작업

- ~~D1 에 최신 마이그레이션 적용 후 bootstrap admin 계정으로 수동 로그인 검증~~ → **완료 (2026-04-16)**
- ~~`signing_keys` 테이블과 연결되는 JWKS 공개 엔드포인트(`/oidc/jwks`) 구현~~ → **완료 (2026-04-16)**
- ~~`/poc/saml-sign` 을 `wrangler dev` 환경에서 호출하여 런타임 검증 완료~~ → **완료 (2026-04-16)** `verified: true`
- ~~`/account/mfa` 에서 TOTP 등록 및 로그인 E2E 수동 검증~~ → **완료 (2026-04-16)** TOTP 등록 → 로그인 → OIDC/SAML 전체 정상 확인
- ~~`/account/passkeys` 에서 passkey 등록 및 로그인 E2E 수동 검증~~ → **완료 (2026-04-16)** 패스키 등록 → 로그아웃 → 패스키 로그인 → OIDC/SAML redirect 정상 확인
- Argon2id(`hash-wasm`) 전환 시점과 롤링 업그레이드 전략을 `M5` 문서에 구체화
