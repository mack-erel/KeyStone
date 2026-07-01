# Keystone IDP

Cloudflare Workers 위에서 동작하는 오픈소스 Identity Provider입니다.
OIDC, SAML 2.0, WebAuthn/Passkey, TOTP 2FA, LDAP 연동을 지원하며 멀티테넌트 조직 관리를 포함합니다.

> **개발 단계 안내**: 본 프로젝트는 활발히 개발 중인 학습/실험 성격의 IdP입니다. 프로덕션 도입 전에는 위협 모델에 맞춘 자체 보안 검토를 권장합니다. 보안 관련 알려진 한계는 [보안 참고사항](#보안-참고사항)을 참조하세요.

## 목차

- [주요 기능](#주요-기능)
- [기술 스택](#기술-스택)
- [디렉터리 구조](#디렉터리-구조)
- [엔드포인트 개요](#엔드포인트-개요)
- [시작하기](#시작하기)
- [환경변수](#환경변수)
- [개발 워크플로](#개발-워크플로)
- [데이터베이스 마이그레이션](#데이터베이스-마이그레이션)
- [보안 참고사항](#보안-참고사항)
- [라이선스](#라이선스)

## 주요 기능

| 기능                   | 설명                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **OIDC**               | Authorization Code + PKCE, Refresh Token, UserInfo, JWKS, End-Session                                            |
| **SAML 2.0**           | SP-Initiated SSO, HTTP-POST 바인딩, ForceAuthn, IsPassive, RequestedAuthnContext, SLO                            |
| **ACR / AMR**          | 인증 방식에 따른 ACR 자동 결정 — SAML Assertion 및 OIDC ID Token에 포함                                          |
| **WebAuthn / Passkey** | 패스키 등록 및 인증, challenge 1회용 DB 처리, 테넌트 격리                                                        |
| **TOTP 2FA**           | Google Authenticator 등 호환, 백업 코드 지원                                                                     |
| **LDAP 연동**          | LDAP 인증 및 JIT 사용자 프로비저닝, 관리자 UI에서 프로바이더 설정                                                |
| **계정 자가 관리**     | 프로필 편집, 비밀번호 재설정/찾기, MFA 등록, Passkey 등록·해제                                                   |
| **조직 관리**          | 부서 → 팀 → 파트 계층, 직급/직책, 복수 소속                                                                      |
| **멀티테넌트**         | 테넌트별 독립 사용자/클라이언트/키 관리                                                                          |
| **관리자 UI**          | 사용자, 조직(부서·팀·파트·직급), OIDC 클라이언트, SAML SP, LDAP 프로바이더, 서명 키, 로그인 스킨, 감사 로그 CRUD |
| **커스텀 로그인 스킨** | OIDC 클라이언트별 커스텀 CSS/스크립트, R2 캐시로 배포                                                            |
| **감사 로그**          | 로그인, SSO, 토큰 발급 등 주요 이벤트 자동 기록, 관리자 UI에서 조회 가능                                         |
| **국제화**             | 메시지 카탈로그 기반 i18n (현재 한국어 제공, 다국어 확장 가능)                                                   |

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

- **Runtime**: Cloudflare Workers (compatibility flags: `nodejs_als`, `nodejs_compat`)
- **Framework**: SvelteKit 2 + Svelte 5 (runes), `@sveltejs/adapter-cloudflare`
- **Database**: Cloudflare D1(SQLite) / PostgreSQL / MySQL 중 택1 (Drizzle ORM). PostgreSQL·MySQL 은 Cloudflare Hyperdrive 로 연결 ([DB 방언 선택](#db-방언-선택-d1--postgresql--mysql) 참고)
- **Object Storage**: Cloudflare R2 (커스텀 로그인 스킨 캐시)
- **Styling**: Tailwind CSS 4
- **Crypto**: Web Crypto API (RSA/EC 서명, argon2id 비밀번호 해시), `@simplewebauthn/*`, `xmldsigjs`
- **Language / Tooling**: TypeScript, Bun, ESLint, Prettier

## 디렉터리 구조

```
src/
├── hooks.server.ts        # 세션 복원, 보안 헤더, 테넌트 컨텍스트
├── app.html
├── routes/
│   ├── (auth)/            # login, signup, logout, mfa, find-id, find-password, reset-password
│   ├── account/           # profile, mfa, passkeys (계정 자가 관리)
│   ├── admin/             # 관리자 UI (users, departments, teams, parts, positions,
│   │                      #            oidc-clients, saml-sps, ldap-providers,
│   │                      #            signing-keys, skins, audit, login)
│   ├── oidc/              # authorize, token, userinfo, jwks, end-session
│   ├── saml/              # sso, slo, metadata
│   └── api/               # webauthn/*, skin-scripts/*
└── lib/
    ├── i18n/              # 메시지 카탈로그 (ko.json)
    ├── assets/
    └── server/
        ├── auth/          # session, password, mfa, totp, webauthn, guards, bootstrap
        ├── oidc/          # client, grant, pkce, logout
        ├── saml/          # sp, metadata, parse-authn-request, response, slo
        ├── ldap/          # auth, client, provision
        ├── crypto/        # 서명 키 관리, JWT 발급, 키 회전
        ├── audit/         # 감사 이벤트 기록
        ├── org/           # 조직 멤버십 조회
        ├── ratelimit/     # 인증 엔드포인트 레이트 리밋
        ├── skin/          # 커스텀 로그인 스킨
        └── db/            # Drizzle 스키마 및 D1 초기화

drizzle/                   # 마이그레이션 SQL (drizzle-kit generate 산출물)
docs/                      # 설계/감사 문서
scripts/setup.ts           # 대화형 초기 셋업 스크립트
```

## 엔드포인트 개요

### OIDC (Discovery: `/.well-known/openid-configuration`)

| 경로                                | 설명                                          |
| ----------------------------------- | --------------------------------------------- |
| `/.well-known/openid-configuration` | OIDC Discovery 문서                           |
| `/oidc/authorize`                   | 인증 요청 (Authorization Code + PKCE)         |
| `/oidc/token`                       | 토큰 교환 (Authorization Code, Refresh Token) |
| `/oidc/userinfo`                    | UserInfo 엔드포인트                           |
| `/oidc/jwks`                        | JSON Web Key Set                              |
| `/oidc/end-session`                 | RP-Initiated Logout                           |

### SAML 2.0

| 경로             | 설명                                 |
| ---------------- | ------------------------------------ |
| `/saml/metadata` | IdP 메타데이터 XML                   |
| `/saml/sso`      | SP-Initiated SSO (AuthnRequest 처리) |
| `/saml/slo`      | Single Logout (체인 SLO 지원)        |

### WebAuthn / 기타 API

| 경로                                 | 설명                                   |
| ------------------------------------ | -------------------------------------- |
| `/api/webauthn/register/options`     | Passkey 등록 challenge 발급            |
| `/api/webauthn/register/verify`      | Passkey 등록 attestation 검증          |
| `/api/webauthn/authenticate/options` | Passkey 인증 challenge 발급            |
| `/api/webauthn/authenticate/verify`  | Passkey 인증 assertion 검증            |
| `/api/skin-scripts/*`                | OIDC 클라이언트별 커스텀 스킨 스크립트 |

### Service-to-Service TOTP API (`DISPATCHER_SERVICE_TOKEN` 필요)

stardust dispatcher 같은 신뢰된 서비스가 사용자 대신 TOTP 등록 / 검증을 위탁하기 위한 API. 모든 요청은 `Authorization: Bearer $DISPATCHER_SERVICE_TOKEN` 헤더 필요 (constant-time 비교).

| 경로                       | 메서드 | 설명                                                          |
| -------------------------- | ------ | ------------------------------------------------------------- |
| `/api/totp/enroll/init`    | POST   | `{userId}` → `{secret, otpAuthUri, username}` (stateless)     |
| `/api/totp/enroll/confirm` | POST   | `{userId, secret, code}` → 검증 + 영구 저장 + `{backupCodes}` |
| `/api/totp/verify`         | POST   | `{userId, code}` → step-up 검증 + `{ok, verifiedAt}`          |
| `/api/totp/status`         | GET    | `?userId=...` → `{enrolled, backupCodeCount, lastUsedAt}`     |

## 시작하기

### 사전 요구사항

- [Bun](https://bun.sh) 1.x
- [Cloudflare 계정](https://dash.cloudflare.com) (D1, R2, Workers 활성화)
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

> R2 버킷(`keystone-skin-cache`)은 커스텀 로그인 스킨 기능을 사용할 때 필요합니다. 사용하지 않는다면 `wrangler.jsonc`의 `r2_buckets` 항목을 주석 처리해도 됩니다.

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

## 환경변수

| 변수                                | 필수 | 설명                                                                                     |
| ----------------------------------- | ---- | ---------------------------------------------------------------------------------------- |
| `IDP_ISSUER_URL`                    | ✅   | OIDC/SAML 발급자 URL (배포 도메인과 일치)                                                |
| `IDP_SIGNING_KEY_SECRET`            | ✅   | 서명 키 암호화 KEK (프로덕션은 반드시 Secret)                                            |
| `DISPATCHER_SERVICE_TOKEN`          | 선택 | stardust dispatcher 가 `/api/totp/*` 호출 시 사용할 Bearer 토큰. 미설정이면 해당 API 503 |
| `IDP_DEFAULT_TENANT_NAME`           | 선택 | 기본 테넌트 이름 (기본: `My Organization`)                                               |
| `CLOUDFLARE_ACCOUNT_ID`             | 선택 | Cloudflare 계정 ID (마이그레이션 스크립트에서 사용)                                      |
| `CLOUDFLARE_D1_DATABASE_ID`         | 선택 | D1 데이터베이스 ID (마이그레이션 스크립트에서 사용)                                      |
| `CLOUDFLARE_D1_PREVIEW_DATABASE_ID` | 선택 | 프리뷰용 D1 데이터베이스 ID                                                              |
| `CLOUDFLARE_D1_TOKEN`               | 선택 | D1 API 토큰 (`db:migrate` 스크립트에서 사용)                                             |

> **참고**: 초기 관리자 계정은 `bun run setup` 실행 시 D1에 직접 생성됩니다. `IDP_BOOTSTRAP_ADMIN_*` 환경변수는 사용하지 않습니다.

### Cloudflare 바인딩 (`wrangler.jsonc`)

| 바인딩       | 종류       | 용도                                                       |
| ------------ | ---------- | ---------------------------------------------------------- |
| `DB`         | D1         | 메인 데이터베이스 (`DB_DIALECT=d1` 일 때)                  |
| `HYPERDRIVE` | Hyperdrive | PostgreSQL/MySQL 연결 (`DB_DIALECT=postgres\|mysql` 일 때) |
| `SKIN_CACHE` | R2         | 커스텀 로그인 스킨 캐시                                    |
| `ASSETS`     | 정적       | SvelteKit 빌드 산출물 (`.svelte-kit/cloudflare`)           |

## 개발 워크플로

| 명령                        | 설명                                               |
| --------------------------- | -------------------------------------------------- |
| `bun run dev`               | Vite 개발 서버 실행                                |
| `bun run build`             | 프로덕션 빌드                                      |
| `bun run preview`           | Wrangler로 빌드 산출물 미리보기 (`localhost:4173`) |
| `bun run check`             | `wrangler types` + `svelte-check` 타입 검사        |
| `bun run lint`              | Prettier + ESLint 검사                             |
| `bun run format`            | Prettier 자동 포맷                                 |
| `bun run gen`               | Wrangler 환경 타입 재생성                          |
| `bun run db:generate`       | Drizzle 마이그레이션 SQL 생성 (D1)                 |
| `bun run db:generate:pg`    | Drizzle 마이그레이션 SQL 생성 (PostgreSQL)         |
| `bun run db:generate:mysql` | Drizzle 마이그레이션 SQL 생성 (MySQL)              |
| `bun run db:studio`         | Drizzle Studio 실행 (스키마/데이터 GUI)            |
| `bun run deploy`            | Cloudflare Workers 배포                            |

## DB 방언 선택 (d1 / postgresql / mysql)

D1(SQLite)·PostgreSQL·MySQL 을 모두 지원하며, **배포 단위로 하나만** 사용합니다. D1 은 편의성이 높지만 지연이 큰 편이라, 낮은 지연이 필요하면 Cloudflare Hyperdrive 로 PostgreSQL/MySQL 에 연결할 수 있습니다.

방언은 `DB_DIALECT` 환경변수로 선택합니다 (`d1`(기본) | `postgres` | `mysql`). 이 값은 **런타임뿐 아니라 빌드·타입체크·마이그레이션 생성 시점에도** 참조되어 스키마·드라이버를 결정합니다.

```bash
# PostgreSQL 로 빌드·배포
DB_DIALECT=postgres bun run build
DB_DIALECT=postgres bun run deploy   # 또는 wrangler deploy

# MySQL 로 빌드·배포
DB_DIALECT=mysql bun run build
```

동작 방식:

- 스키마는 방언별로 분리되어 있습니다: `schema.sqlite.ts` / `schema.pg.ts` / `schema.mysql.ts`. 세 스키마는 테이블·컬럼·인덱스명과 JS 추론 타입이 동일하게 유지되며, 배럴 `schema.ts` 가 `DB_DIALECT` 에 맞는 파일로 해석됩니다.
- `src/lib/server/db/index.ts` 의 `getDb()` 가 방언에 맞는 드라이버(d1 / postgres-js / mysql2)를 선택합니다. 빌드 시 활성 방언의 드라이버만 워커 번들에 포함됩니다.
- **PostgreSQL/MySQL 은 `HYPERDRIVE` 바인딩이 필요합니다.**

```bash
# Hyperdrive 구성 생성 (binding 이름은 반드시 HYPERDRIVE)
wrangler hyperdrive create keystone-pg    --connection-string="postgres://user:pass@host:5432/db"
wrangler hyperdrive create keystone-mysql --connection-string="mysql://user:pass@host:3306/db"
# → 출력된 id 를 wrangler.jsonc 의 hyperdrive[].id 에 채우고 주석 해제
```

> **참고**: MySQL 은 `UPDATE ... RETURNING` 과 partial(부분) unique index 를 지원하지 않습니다. 해당 로직(인가 코드/WebAuthn challenge 소진, signing key 회전)은 방언별로 분기되어 MySQL 에서는 `affectedRows` 판정·재조회와 트랜잭션으로 동등하게 동작합니다.

## 데이터베이스 마이그레이션

스키마 변경 → 마이그레이션 생성 → 적용의 흐름은 다음과 같습니다.

```bash
# 1. 사용하는 방언의 스키마 파일 수정
#    - D1        → src/lib/server/db/schema.sqlite.ts
#    - PostgreSQL → src/lib/server/db/schema.pg.ts
#    - MySQL      → src/lib/server/db/schema.mysql.ts
#    (세 스키마의 구조/타입은 동일하게 유지할 것)

# 2. SQL 생성 (사용하는 방언에 맞게)
bun run db:generate          # D1        → drizzle/*.sql
bun run db:generate:pg       # PostgreSQL → drizzle/pg/*.sql
bun run db:generate:mysql    # MySQL      → drizzle/mysql/*.sql

# 3. 생성된 SQL 파일 검토

# 4. 원격 DB에 적용 (사용자가 직접 실행)
bun run db:migrate          # D1 프로덕션
bun run db:migrate:preview  # D1 프리뷰
# PostgreSQL/MySQL 은 DATABASE_URL 설정 후 drizzle-kit migrate 로 적용
```

> ⚠️ 원격 D1에 대한 마이그레이션 적용은 되돌리기 어려우므로, 자동화된 스크립트나 에이전트가 임의로 실행하지 않도록 운영 정책에 포함시키는 것을 권장합니다.

## 보안 참고사항

### 비밀번호 해싱

신규 비밀번호는 **argon2id** (`@hicaru/argon2-pure.js`, Workers 호환 순수 JS 구현)로 해싱됩니다. 과거 PBKDF2-SHA256 (100,000 iterations)으로 저장된 레거시 해시는 **로그인 검증 시 자동으로 argon2id로 재해싱**됩니다.

### 서명 키

OIDC ID Token 및 SAML Response 서명에 사용되는 RSA 키는 `IDP_SIGNING_KEY_SECRET`으로 암호화되어 D1에 저장됩니다. 이 시크릿이 유출되면 모든 서명 키가 복호화될 수 있으므로 반드시 강한 랜덤값(`openssl rand -base64 32`)을 사용하고 정기적으로 교체하세요. 키 회전은 관리자 UI(`/admin/signing-keys`)에서 수행할 수 있습니다.

### WebAuthn challenge

WebAuthn 등록·인증 challenge는 D1에 1회용으로 저장되며, 소진 즉시 삭제됩니다. challenge는 테넌트 ID로 격리되어 다른 테넌트의 challenge를 재사용할 수 없습니다.

### LDAP 계정 연결 정책

LDAP 인증 성공 시, 동일 이메일의 기존 로컬 계정이 있는 경우 **자동 연결하지 않습니다.** LDAP 프로바이더가 이메일을 조작해 기존 관리자 계정을 탈취하는 것을 방지하기 위함입니다. 기존 로컬 계정과의 연결은 관리자가 직접 수행해야 합니다.

### 보안 헤더

`hooks.server.ts`에서 모든 응답에 다음 헤더를 적용합니다.

- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Strict-Transport-Security` (HSTS)
- `Permissions-Policy` (camera/microphone/geolocation/payment 비활성)
- 해시 기반 `Content-Security-Policy`

### 부트스트랩 관리자

초기 관리자 계정은 `bun run setup` 실행 시 D1에 직접 삽입됩니다. 셋업 완료 후 가능한 빨리 비밀번호를 변경하고 MFA를 설정하는 것을 권장합니다.

## 라이선스

[MIT](LICENSE)
