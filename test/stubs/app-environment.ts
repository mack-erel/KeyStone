// vitest 용 $app/environment 스텁.
//
// 통합 테스트는 실제 서버 모듈(hooks/bootstrap/runtime/route 핸들러)을 직접 import 해
// 구동하는데, 이들이 SvelteKit 의 `$app/environment` 에서 `dev`/`building` 등을 읽는다.
// 순수 유닛 설정에는 이 alias 가 없어 해석이 깨지므로 최소 스텁을 제공한다.
//
// dev=false 로 둔다 — 이는 "프로덕션 경로" 를 그대로 구동한다는 뜻이다:
//   - runtime.resolveIssuerUrl 은 issuerUrl 이 설정돼 있으면 그 값을 반환하고(테스트는
//     platform.env.IDP_ISSUER_URL 로 주입한다), 미설정 시에만 dev 분기를 탄다.
//   - bootstrap.assertRequiredConfig 는 ensureAuthBaseline 경로에서만 동작하는데, 하네스는
//     ensureDefaultTenant/ensureSigningKey 를 직접 호출하므로 이 검증 경로를 타지 않는다.
// 따라서 dev=false 라도 통합 테스트는 필요한 값이 주입돼 있어 정상 구동된다.
export const dev = false;
export const building = false;
export const browser = false;
export const version = "test";
