# Workers 환경 PoC 노트

킥오프 M0 리스크 R1/R2 사전 검증.

## 범위

- `/poc/rs256` — RS256 JWT 서명/검증
- `/poc/argon2` — 패스워드 해시 가능성
- `/poc/saml-sign` — SAML Assertion 서명 가능성

## 결과 요약

| 항목                               | 상태                                | 비고                                                                                                                        |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| RS256 JWT (WebCrypto)              | ✅ OK                               | 외부 의존성 없이 동작. OIDC ID Token 서명 그대로 사용 가능.                                                                 |
| 패스워드 해시 (PBKDF2-SHA256 600k) | ✅ OK (`M0` 구현 반영 완료)         | WebCrypto 네이티브. 현재 로그인/부트스트랩 관리자 계정 검증에 사용 중. `M5` 에서 argon2id 교체 예정.                        |
| SAML Assertion 서명                | ✅ OK (`2026-04-16`)               | `xmldsigjs + @xmldom/xmldom` 런타임 검증 완료. `verified: true`, 서명 46ms (keygen 43ms, sign 2ms, verify 1ms). `setNodeDependencies({ DOMParser, XMLSerializer, xpath })` 등록 필요. |
| 개발 체인 (`lint/check/build`)     | ✅ OK (`2026-04-16` 기준 검증 완료) | `wrangler types --check`, `svelte-check`, `vite build` 까지 통과.                                                           |
| M0 수동 로그인 검증                 | ✅ OK (`2026-04-16`)               | D1 마이그레이션 적용, bootstrap admin 아이디/비밀번호 로그인 → `/admin` 리다이렉트 확인.                                    |

## 실구현 반영 상태 (2026-04-16)

- `PBKDF2-SHA256 600k` 결정은 실제 인증 모듈에 반영되었고, `credentials.secret` 포맷은 `pbkdf2$sha256:600000$<salt>$<hash>` 형태를 사용한다.
- `default` tenant bootstrap, bootstrap admin seed, 로그인/로그아웃, 세션 쿠키, 감사 로그 저장/조회까지 `M0` 범위로 구현되었다.
- 로그인 식별자를 이메일에서 **아이디(username)** 로 변경. `users.username` 컬럼 추가(`drizzle/0002_dizzy_korvac.sql`), bootstrap 시 `IDP_BOOTSTRAP_ADMIN_USERNAME` 미설정이면 email 로컬파트 자동 사용.
- D1 마이그레이션 적용 및 `wrangler dev` 환경에서 아이디/비밀번호 로그인 수동 검증 완료 (2026-04-16). **M0 완전 완료.**
- `signing_keys` 스키마와 JWK 저장 구조는 준비되었지만, 실제 `/oidc/jwks` 공개 엔드포인트는 아직 구현하지 않았다.
- SAML 서명 PoC 는 코드와 빌드 기준으로는 유지되고 있으나, Workers 런타임 요청으로 실제 왕복 검증한 상태는 아직 아니다.

## 의사결정 기록

1. ~~패스워드 해시~~ → **확정 (2026-04-15)**: MVP 는 **PBKDF2-SHA256 600k** (WebCrypto 네이티브, 번들 없음). 블로그 프로젝트와 동일 접근. M5 에서 **argon2id (`hash-wasm`)** 로 교체.
   - `credentials.secret` 포맷: `<algo>$<params>$<salt>$<hash>` — 예: `pbkdf2$sha256:600000$<salt_b64>$<hash_b64>` / `argon2id$m=65536,t=3,p=4$<salt_b64>$<hash_b64>`
   - 검증 시 prefix 파싱 → 알고리즘 분기. 교체 시 로그인 성공 순간 재해시하여 새 포맷으로 upgrade (무중단).
2. **SAML 서명 라이브러리**: `xmldsigjs + @xmldom/xmldom` 채택 후보 1순위. 번들 통과(2026-04-15). 런타임 검증 후 확정.

## 다음 작업

- ~~D1 에 최신 마이그레이션 적용 후 bootstrap admin 계정으로 수동 로그인 검증~~ → **완료 (2026-04-16)**
- `signing_keys` 테이블과 연결되는 JWKS 공개 엔드포인트(`/oidc/jwks`) 구현 (M1)
- ~~`/poc/saml-sign` 을 `wrangler dev` 환경에서 호출하여 런타임 검증 완료~~ → **완료 (2026-04-16)** `verified: true`
- Argon2id(`hash-wasm`) 전환 시점과 롤링 업그레이드 전략을 `M5` 문서에 구체화
