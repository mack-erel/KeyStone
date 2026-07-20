import type { X509Certificate } from "@peculiar/x509";
import { env } from "$env/dynamic/private";

/**
 * SP 인증서 유효기간(notBefore/notAfter) 검증.
 *
 * ctrls R2: 서명 검증·암호화 시 SP 인증서의 공개키만 꺼내 쓰고 유효기간은 보지 않으면,
 * 만료됐거나 교체된 SP 키로도 무기한 서명이 통과된다(신뢰가 admin 등록 cert 에 핀 고정돼
 * 있어 spoofing 은 아니지만, 만료/로테이션 위생을 잃는 defense-in-depth 갭).
 *
 * 기본값 on(강제). SAML 관례상 self-signed SP cert 를 만료 무시 키 컨테이너로 쓰는 SP 와의
 * 상호운용이 필요하면 `IDP_ENFORCE_SP_CERT_VALIDITY=false` 로 명시적으로 완화할 수 있다.
 *
 * @returns 검증 통과(또는 강제 비활성) 시 true.
 */
export function isSpCertTimeValid(cert: X509Certificate, now: Date = new Date()): boolean {
    if (env.IDP_ENFORCE_SP_CERT_VALIDITY === "false") return true;
    return now >= cert.notBefore && now <= cert.notAfter;
}
