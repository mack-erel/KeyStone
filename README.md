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

### 설치 및 셋업

```bash
git clone https://github.com/mack-erel/KeyStone.git
cd KeyStone
bun install
bun run setup
```

`bun run setup`은 아래 과정을 대화형으로 안내합니다:

1. **wrangler 로그인 확인** — 미로그인 시 `wrangler login` 자동 실행
2. **설정 파일 생성** — `wrangler.example.jsonc` → `wrangler.jsonc`, `.env.example` → `.env`
3. **D1 데이터베이스** — 새로 생성하거나 기존 DB 선택 (프리뷰 DB 선택적)
4. **마이그레이션** — 스키마를 D1에 적용 (충돌 테이블 감지 및 처리 포함)
5. **초기 관리자 설정** — 조직명, 관리자 계정 정보, Issuer URL
6. **서명 키** — `IDP_SIGNING_KEY_SECRET` 자동 생성 또는 직접 입력

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
wrangler secret put IDP_BOOTSTRAP_ADMIN_PASSWORD
```

> **참고**: 로컬 개발에서는 `.env`에 평문으로 저장해도 무방하지만, 프로덕션에서는 반드시 Secret으로 관리하세요.

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
