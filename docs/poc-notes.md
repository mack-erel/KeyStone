# Workers 환경 PoC 노트

킥오프 M0 리스크 R1/R2 사전 검증.

## 범위
- `/poc/rs256` — RS256 JWT 서명/검증
- `/poc/argon2` — 패스워드 해시 가능성
- `/poc/saml-sign` — SAML Assertion 서명 가능성

## 결과 요약

| 항목 | 상태 | 비고 |
|---|---|---|
| RS256 JWT (WebCrypto) | ✅ OK | 외부 의존성 없이 동작. OIDC ID Token 서명 그대로 사용 가능. |
| 패스워드 해시 (PBKDF2-SHA256 600k) | ✅ OK (MVP) | WebCrypto 네이티브. M5 에서 argon2id 교체 예정. |
| SAML Assertion 서명 | 🟡 번들 OK / 런타임 미확인 | `xmldsigjs + @xmldom/xmldom` Workers 번들 성공 (2.25 kB). `bun run dev` 로 `/poc/saml-sign` 호출하여 런타임 동작 확인 필요. |

## 의사결정 기록

1. ~~패스워드 해시~~ → **확정 (2026-04-15)**: MVP 는 **PBKDF2-SHA256 600k** (WebCrypto 네이티브, 번들 없음). 블로그 프로젝트와 동일 접근. M5 에서 **argon2id (`hash-wasm`)** 로 교체.
   - `credentials.secret` 포맷: `<algo>$<params>$<salt>$<hash>` — 예: `pbkdf2$sha256:600000$<salt_b64>$<hash_b64>` / `argon2id$m=65536,t=3,p=4$<salt_b64>$<hash_b64>`
   - 검증 시 prefix 파싱 → 알고리즘 분기. 교체 시 로그인 성공 순간 재해시하여 새 포맷으로 upgrade (무중단).
2. **SAML 서명 라이브러리**: `xmldsigjs + @xmldom/xmldom` 채택 후보 1순위. 번들 통과(2026-04-15). 런타임 검증 후 확정.

## 다음 작업
- 위 두 결정이 난 뒤 실 라이브러리 통합 PoC 재수행
- `signing_keys` 테이블에 PoC 에서 생성한 JWK 저장 흐름 연결
- JWKS 공개 엔드포인트(`/oidc/jwks`) 스캐폴드
