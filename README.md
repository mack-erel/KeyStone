# IDP — Identity Provider

Cloudflare Workers 위에서 동작하는 오픈소스 Identity Provider입니다.  
OIDC, SAML 2.0, WebAuthn/Passkey, TOTP 2FA, LDAP 연동을 지원하며 멀티테넌트 조직 관리를 포함합니다.

## 주요 기능

| 기능                   | 설명                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| **OIDC**               | Authorization Code + PKCE, Refresh Token, UserInfo, JWKS                         |
| **SAML 2.0**           | SP-Initiated SSO, HTTP-POST 바인딩, ForceAuthn, IsPassive, RequestedAuthnContext |
| **ACR / AMR**          | 인증 방식에 따른 ACR 자동 결정 — SAML Assertion 및 OIDC ID Token에 포함          |
| **WebAuthn / Passkey** | 패스키 등록 및 인증, challenge 1회용 DB 처리, 테넌트 격리                        |
| **TOTP 2FA**           | Google Authenticator 등 호환, 백업 코드 지원                                     |
| **LDAP 연동**          | LDAP 인증 및 JIT 사용자 프로비저닝, 관리자 UI에서 프로바이더 설정                |
| **조직 관리**          | 부서 → 팀 → 파트 계층, 직급/직책, 복수 소속                                      |
| **멀티테넌트**         | 테넌트별 독립 사용자/클라이언트/키 관리                                          |
| **관리자 UI**          | 사용자, OIDC 클라이언트, SAML SP, LDAP 프로바이더, 감사 로그 CRUD                |
| **감사 로그**          | 로그인, SSO, 토큰 발급 등 주요 이벤트 자동 기록, 관리자 UI에서 조회 가능         |

### ACR / AMR 매핑

세션의 인증 방식(AMR)에 따라 ACR이 자동으로 결정되어 SAML Assertion 및 OIDC ID Token에 포함됩니다.

| 인증 방식            | AMR 값        | ACR 값                                                              |
| -------------------- | ------------- | ------------------------------------------------------------------- |
| 비밀번호만           | `pwd`         | `urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport` |
| 비밀번호 + TOTP      | `pwd`, `totp` | `https://refeds.org/profile/mfa`                                    |
| 비밀번호 + 백업 코드 | `pwd`, `swk`  | `https://refeds.org/profile/mfa`                                    |
| WebAuthn / Passkey   | `hwk`         | `https://refeds.org/profile/mfa`                                    |

SAML SP가 `RequestedAuthnContext`로 특정 ACR을 요구하는 경우, 세션 ACR이 해당 수준을 만족하지 않으면 재인증이 강제됩니다. MFA 미설정 등으로 만족 불가 시 `NoAuthnContext` 오류가 ACS URL로 반환됩니다.

### SAML SP별 속성 필터링

각 SP에 `allowedAttributes` 목록을 설정하여 Assertion에 포함할 속성을 제어할 수 있습니다. 미설정 시 `email`, `username`, `displayName`만 기본 포함됩니다. 조직 정보(`department`, `team`, `jobTitle`, `position`)는 SP가 명시적으로 허용한 경우에만 포함됩니다.

## 기술 스택

- **Runtime**: Cloudflare Workers
- **Framework**: SvelteKit (adapter-cloudflare)
- **Database**: Cloudflare D1 (SQLite)
- **ORM**: Drizzle ORM
- **Language**: TypeScript

## 시작하기

### 사전 요구사항

- [Bun](https://bun.sh) 1.x
- [Cloudflare 계정](https://dash.cloudflare.com) (D1, Workers 활성화)
- Wrangler CLI (`bun add -g wrangler`)

### 설치 및 셋업

```bash
git clone https://github.com/mack-erel/idp.git
cd idp
bun install
bun run setup
```

`bun run setup`은 아래 과정을 대화형으로 안내합니다:

1. **wrangler 로그인 확인** — 미로그인 시 `wrangler login` 자동 실행
2. **설정 파일 생성** — `wrangler.example.jsonc` → `wrangler.jsonc`, `.env.example` → `.env`
3. **D1 데이터베이스** — 새로 생성하거나 기존 DB 선택 (프리뷰 DB 선택적)
4. **파일 업데이트** — DB ID 및 계정 ID를 `wrangler.jsonc`, `.env`에 자동 기입
5. **마이그레이션** — `bun run db:generate` 실행 후 D1에 스키마 적용 (충돌 테이블 감지 및 처리 포함)
6. **초기 관리자 계정 생성** — 조직명, 관리자 계정 정보, Issuer URL 입력 후 D1에 직접 삽입 (비밀번호 미입력 시 자동 생성)
7. **서명 키** — `IDP_SIGNING_KEY_SECRET` 자동 생성 또는 직접 입력 후 `.env`에 저장

셋업 완료 후 로컬 개발 서버를 시작합니다:

```bash
bun run dev
```

### 프로덕션 배포

```bash
bun run deploy
```

배포 전 Wrangler Secret으로 민감한 값을 설정합니다:

```bash
wrangler secret put IDP_SIGNING_KEY_SECRET
```

> **참고**: 로컬 개발에서는 `.env`에 평문으로 저장해도 무방하지만, 프로덕션에서는 반드시 Secret으로 관리하세요.

## 환경변수 전체 목록

| 변수                                | 필수 | 설명                                                |
| ----------------------------------- | ---- | --------------------------------------------------- |
| `IDP_ISSUER_URL`                    | ✅   | OIDC/SAML 발급자 URL (배포 도메인과 일치)           |
| `IDP_SIGNING_KEY_SECRET`            | ✅   | 서명 키 암호화 KEK (Secret으로 설정)                |
| `IDP_DEFAULT_TENANT_NAME`           | 선택 | 기본 테넌트 이름 (기본: `My Organization`)          |
| `CLOUDFLARE_ACCOUNT_ID`             | 선택 | Cloudflare 계정 ID (마이그레이션 스크립트에서 사용) |
| `CLOUDFLARE_D1_DATABASE_ID`         | 선택 | D1 데이터베이스 ID (마이그레이션 스크립트에서 사용) |
| `CLOUDFLARE_D1_PREVIEW_DATABASE_ID` | 선택 | 프리뷰용 D1 데이터베이스 ID                         |
| `CLOUDFLARE_D1_TOKEN`               | 선택 | D1 API 토큰 (`db:migrate` 스크립트에서 사용)        |

> **참고**: 초기 관리자 계정은 `bun run setup` 실행 시 D1에 직접 생성됩니다. `IDP_BOOTSTRAP_ADMIN_*` 환경변수는 사용하지 않습니다.

## 보안 참고사항

### 패스워드 해싱

Cloudflare Workers 환경 제약(WebAssembly 인라인 컴파일 불가)으로 인해 argon2id 대신 **PBKDF2-SHA256 (100,000 iterations)** 을 사용합니다. OWASP 권장 최솟값(600,000)보다 낮은 점을 인지하고 배포 환경의 위협 모델을 고려하여 사용하세요.

### 서명 키

OIDC ID Token 및 SAML Response 서명에 사용되는 RSA 키는 `IDP_SIGNING_KEY_SECRET`으로 암호화되어 D1에 저장됩니다. 이 시크릿이 유출되면 모든 서명 키가 복호화될 수 있으므로 반드시 강한 랜덤값을 사용하고 정기적으로 교체하세요.

### WebAuthn challenge 보안

WebAuthn 인증 challenge는 DB에 1회용으로 저장되며, 소진 즉시 삭제됩니다. challenge는 테넌트 ID로 격리되어 다른 테넌트의 challenge를 재사용할 수 없습니다.

### LDAP 계정 연결 정책

LDAP 인증 성공 시, 동일 이메일의 기존 로컬 계정이 있는 경우 자동 연결하지 않습니다. LDAP 프로바이더가 이메일을 조작해 기존 관리자 계정을 탈취하는 것을 방지하기 위함입니다. 기존 로컬 계정과의 연결은 관리자가 직접 수행해야 합니다.

### 부트스트랩 관리자

초기 관리자 계정은 `bun run setup` 실행 시 D1에 직접 삽입됩니다. 셋업 완료 후에는 관리자 UI에서 비밀번호를 변경하는 것을 권장합니다.

## 라이선스

[MIT](LICENSE)
