# IDP — Identity Provider

Cloudflare Workers 위에서 동작하는 오픈소스 Identity Provider입니다.  
OIDC, SAML 2.0, WebAuthn/Passkey, TOTP 2FA를 지원하며 멀티테넌트 조직 관리를 포함합니다.

## 주요 기능

| 기능                   | 설명                                                     |
| ---------------------- | -------------------------------------------------------- |
| **OIDC**               | Authorization Code + PKCE, Refresh Token, UserInfo, JWKS |
| **SAML 2.0**           | SP-Initiated SSO, HTTP-POST 바인딩, 서명 검증            |
| **WebAuthn / Passkey** | 패스키 등록 및 인증                                      |
| **TOTP 2FA**           | Google Authenticator 등 호환                             |
| **조직 관리**          | 부서 → 팀 → 파트 계층, 직급/직책, 복수 소속              |
| **멀티테넌트**         | 테넌트별 독립 사용자/클라이언트/키 관리                  |
| **관리자 UI**          | 사용자, OIDC 클라이언트, SAML SP, 조직 CRUD              |

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

### 설치

```bash
git clone https://github.com/your-org/keystone.git
cd keystone
bun install
```

### Cloudflare D1 데이터베이스 생성

```bash
# 프로덕션 DB
wrangler d1 create keystone-db

# 프리뷰 DB (선택)
wrangler d1 create keystone-db-preview
```

### 설정

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc`를 열어 아래 항목을 실제 값으로 교체합니다:

| 항목                         | 설명                                          |
| ---------------------------- | --------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`      | Cloudflare 대시보드 우측 하단                 |
| `CLOUDFLARE_D1_DATABASE_ID`  | `wrangler d1 create` 결과값                   |
| `IDP_ISSUER_URL`             | 배포할 도메인 (예: `https://keystone.example.com`) |
| `routes[].pattern`           | 배포 도메인                                   |
| `d1_databases[].database_id` | D1 database_id                                |

### 시크릿 설정 (필수)

평문으로 설정 파일에 입력하지 말고 반드시 Wrangler Secret으로 설정합니다:

```bash
# 관리자 초기 비밀번호
wrangler secret put IDP_BOOTSTRAP_ADMIN_PASSWORD

# 서명 키 암호화 시크릿 (최소 32자 랜덤 문자열)
openssl rand -base64 32 | wrangler secret put IDP_SIGNING_KEY_SECRET
```

### 데이터베이스 마이그레이션

```bash
# 프리뷰 D1에 적용
bun run db:migrate:preview

# 프로덕션 D1에 적용
bun run db:migrate
```

### 로컬 개발

```bash
bun run dev
```

### 배포

```bash
bun run deploy
```

## 환경변수 전체 목록

| 변수                           | 필수 | 설명                                      |
| ------------------------------ | ---- | ----------------------------------------- |
| `IDP_ISSUER_URL`               | ✅   | OIDC/SAML 발급자 URL                      |
| `IDP_SIGNING_KEY_SECRET`       | ✅   | 서명 키 암호화 KEK (Secret으로 설정)      |
| `IDP_BOOTSTRAP_ADMIN_EMAIL`    | 선택 | 초기 관리자 이메일                        |
| `IDP_BOOTSTRAP_ADMIN_PASSWORD` | 선택 | 초기 관리자 비밀번호 (Secret으로 설정)    |
| `IDP_BOOTSTRAP_ADMIN_USERNAME` | 선택 | 초기 관리자 아이디 (기본: `admin`)        |
| `IDP_BOOTSTRAP_ADMIN_NAME`     | 선택 | 초기 관리자 표시 이름                     |
| `IDP_DEFAULT_TENANT_NAME`      | 선택 | 기본 테넌트 이름 (기본: `Default Tenant`) |
| `CLOUDFLARE_ACCOUNT_ID`        | 선택 | Cloudflare 계정 ID                        |
| `CLOUDFLARE_D1_DATABASE_ID`    | 선택 | D1 데이터베이스 ID                        |

## 보안 참고사항

### 패스워드 해싱

Cloudflare Workers 환경 제약(WebAssembly 인라인 컴파일 불가)으로 인해 argon2id 대신 **PBKDF2-SHA256 (100,000 iterations)** 을 사용합니다. OWASP 권장 최솟값(600,000)보다 낮은 점을 인지하고 배포 환경의 위협 모델을 고려하여 사용하세요.

### 서명 키

OIDC ID Token 및 SAML Response 서명에 사용되는 RSA 키는 `IDP_SIGNING_KEY_SECRET`으로 암호화되어 D1에 저장됩니다. 이 시크릿이 유출되면 모든 서명 키가 복호화될 수 있으므로 반드시 강한 랜덤값을 사용하고 정기적으로 교체하세요.

### 부트스트랩 관리자

`IDP_BOOTSTRAP_ADMIN_*` 환경변수는 최초 배포 시 관리자 계정을 자동 생성합니다. 배포 후에는 관리자 UI에서 비밀번호를 변경하거나 해당 환경변수를 제거하는 것을 권장합니다.

## 라이선스

[MIT](LICENSE)
