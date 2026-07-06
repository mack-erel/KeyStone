# `IDP_SIGNING_KEY_SECRET` 회전 절차

> 작성: 2026-07-06 (코드 기준 조사: `src/lib/server/crypto/keys.ts`, `auth/totp.ts`, `auth/mfa.ts`, `auth/webauthn.ts`, `audit/index.ts`).
> 이 시크릿은 단일 마스터 값이며 **키 버전/이중 시크릿 fallback이 없다** — 무중단(zero-downtime) 회전은 현재 코드로는 불가능하고, 아래 절차의 재암호화 창 동안 일부 요청이 실패할 수 있다.

## 1. 이 시크릿이 쓰이는 곳 (7용도)

| #   | 용도                                  | 방식                                                                  | 저장 데이터                                                  | 근거                     |
| --- | ------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------ |
| 1   | OIDC/SAML 서명용 RSA private JWK 래핑 | HKDF(`idp-signing-key-wrap-v1`) → AES-256-GCM                         | `signing_keys.private_jwk_encrypted` (활성 행만 런타임 사용) | `crypto/keys.ts:37-69`   |
| 2   | Opaque access token 서명/검증         | **원문 그대로** HMAC-SHA256 키                                        | 저장 없음 (TTL 300초)                                        | `crypto/keys.ts:213-250` |
| 3   | LDAP admin bind password 암호화       | HKDF(`idp-ldap-bind-password-v1`) → AES-256-GCM                       | `identity_providers.config_json` 내 `bindPasswordEnc`        | `crypto/keys.ts:258-280` |
| 4   | TOTP seed 암호화                      | HKDF(v2: `idp-totp-secret-wrap-v2:<userId>`, v1 레거시) → AES-256-GCM | `credentials.secret` (type='totp')                           | `auth/totp.ts:99-175`    |
| 5   | MFA pending 쿠키 서명                 | 원문 HMAC                                                             | 저장 없음 (쿠키, TTL 5분)                                    | `auth/mfa.ts:44-92`      |
| 6   | WebAuthn challenge 쿠키 서명          | 원문 HMAC                                                             | 저장 없음 (쿠키, TTL 5분)                                    | `auth/webauthn.ts:28-58` |
| 7   | 감사 로그 행 무결성 MAC               | 원문 HMAC                                                             | `audit_events.hash` (평문 필드에 대한 MAC — 암호화 아님)     | `audit/index.ts:93-124`  |

## 2. 회전 시 영향 분류

**A. 자연 해소(조치 불필요)** — 발급된 access token(최대 5분 내 만료), MFA pending·WebAuthn challenge 쿠키(5분, 재시도로 해소). `oidc_refresh_tokens`는 이 시크릿과 무관(랜덤 토큰 + SHA-256 해시)이라 영향 없음.

**B. 재암호화 필수(누락 시 장애)** — 아래 3종은 old secret으로 복호해 new secret으로 재암호화하지 않으면 **영구 복호 불가**:

| 데이터                                                                                 | 미조치 시 증상                                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `signing_keys` 활성 행(`active=true AND rotated_at IS NULL`)의 `private_jwk_encrypted` | unwrap 예외(try/catch 없음) → OIDC 토큰 발급·SAML SSO 전면 500                   |
| `credentials.secret` (TOTP 전량)                                                       | `api/totp/verify` 500 → TOTP 사용자 전원 MFA 로그인 불가                         |
| `identity_providers.config_json.bindPasswordEnc` (LDAP)                                | 복호 실패는 try/catch로 흡수되나 bind 자격증명 부재 → 해당 LDAP 로그인 전부 실패 |

**C. 선택 후처리** — `audit_events.hash`: 원본 평문이 DB에 있으므로 new secret으로 전량 재계산 가능(전용 스크립트는 현재 없음). 재계산하지 않으면 향후 무결성 검증 시 old-secret 시절 행이 전부 오탐된다.

## 3. 회전 절차 (순서 엄수)

1. **준비**: 새 secret 생성(고엔트로피 256bit 이상). old secret을 재암호화 작업 완료까지 안전하게 보관. 트래픽이 낮은 시간대 선택(재암호화~재배포 사이 실패 창 존재).
2. **재암호화 배치 실행** (전용 스크립트 신규 작성 필요 — 리포에 기성 스크립트 없음):
    - 각 테넌트 `signing_keys` 활성 행: `unwrapPrivateKey(old)` → `wrapPrivateKey(new)` 재래핑. (`rotated_at`이 찍힌 과거 행은 코드가 읽지 않으므로 스킵 가능.)
    - `credentials` type='totp' 전량: `decryptTotpSecret(old, userId)` → `encryptTotpSecret(new, userId)` (v1 레거시 행은 userId 바인딩 없이 복호됨).
    - LDAP `bindPasswordEnc`: `decryptSecret(old, "idp-ldap-bind-password-v1")` → `encryptSecret(new, ...)`.
3. **시크릿 교체·재배포**: `wrangler secret put IDP_SIGNING_KEY_SECRET`(Workers) 또는 환경변수 교체(Node) 후 재배포. **반드시 2단계 완료 후에.**
4. **스모크 테스트**: `/oidc/token` 발급, `/saml/sso` 서명, TOTP 로그인, LDAP 로그인 — 전부 무보호 복호 경로를 타므로 실패 시 즉시 드러난다. JWKS(`/oidc/jwks`)의 kid 정상 노출 확인.
5. **(선택)** `audit_events.hash` 전량 재계산 배치.
6. **old secret 파기**.

## 4. 알려진 한계 / 개선 여지 (별도 트랙)

- 다중 시크릿 fallback(old/new 동시 시도)이 없어 완전 무중단 회전 불가 — 시크릿 버전 태깅 + 순차 재암호화 지원이 근본 해법.
- access-token HMAC·쿠키 서명(#2,#5,#6,#7)이 파생 없이 원문을 공유 — HKDF 도메인 분리로 통일하면 용도별 노출 반경이 줄어든다(단, 교체 시 위 A 항목의 즉시 무효화 특성은 동일).
- admin 콘솔의 "서명키 rotate" 액션은 **현재 secret으로 새 서명키를 만드는 것**이지 이 마스터 시크릿 회전과 무관하다 — 혼동 주의.
