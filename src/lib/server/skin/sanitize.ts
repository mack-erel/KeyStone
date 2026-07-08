// ctrls C-14: 외부 호스트 skin HTML 의 sanitize — Cloudflare HTMLRewriter 기반.
//
// CSP 가 1차 방어선이지만 (script-src 'self', img-src 'self' 등) skin 호스트가
// 침해됐을 때 단일 우회로 RCE/credential exfil 표면이 노출되지 않도록 HTML
// 자체에서도 위험 태그/속성을 제거한다.
//
// 정상 skin 디자이너에게 영향 없는 범위:
//   - <script> 자체가 현재 CSP 로 차단되므로 sanitize 가 제거해도 동작 영향 0
//   - 외부 src/href (img/link/script) 도 CSP 로 차단된 상태이므로 영향 0
//   - <form action> 만 자동 제거 — action 없는 폼은 현재 페이지 (= IDP) 로
//     POST 되어 정상 로그인 흐름이 유지됨. 외부 action 만 차단됨.
//
// Cloudflare Workers 의 HTMLRewriter 를 사용 — DOMPurify 류는 Workers 호환
// DOM 구현이 없어 동작 불가/불안정. HTMLRewriter 는 streaming HTML parser 로
// Workers 네이티브이고 bun 에서도 동작.

// 제거할 태그 (자식 내용도 함께 사라짐: script/style 처럼 children 이 텍스트인 경우)
//
// <style> 은 CSP style-src 'unsafe-inline' 하에서 통과되므로, 침해된 skin 호스트가
// 인라인 <style> 로 로그인 폼을 리드레싱/은닉해 자격증명 피싱을 시도할 수 있다.
// 정상 skin 은 <link>/외부 CSS 가 아니라 CSP 로 허용된 경로를 쓰므로 영향 없음.
const FORBIDDEN_TAGS = ["script", "style", "iframe", "object", "embed", "base", "meta", "link"];

// 제거할 속성 (모든 태그 공통)
const FORBIDDEN_ATTRIBUTES = new Set([
    "action",
    "formaction",
    "srcdoc",
    "sandbox",
    "background", // 옛 IE 의 body background
]);

// on* 이벤트 핸들러 패턴
const EVENT_HANDLER_RE = /^on[a-z]/i;

// ctrls M-7: 인라인 style 속성에서 리드레싱/오버레이(가짜 로그인 필드로 실제 폼을 덮는
// 자격증명 피싱)에 악용되는 위치/레이어링 속성만 제거한다. <style>/<link> 태그는 이미
// FORBIDDEN_TAGS 로 제거되므로 정상 skin 은 인라인 style 로 색상/폰트/여백을 주는데,
// 이는 보존하고 position/z-index/transform/inset 계열만 무력화한다(피싱 벡터 차단).
// 완벽한 CSS 리드레싱 방지는 아니지만(음수 margin 등 잔여), JS 는 CSP 로 이미 차단된
// 상태에서 주된 오버레이 수단을 제거하는 심층 방어다.
const DANGEROUS_STYLE_PROP_RE = /(^|;)\s*(position|top|left|right|bottom|inset(?:-[a-z]+)?|z-index|transform(?:-origin)?|perspective|float|clip|clip-path)\s*:[^;]*/gi;

function sanitizeStyleAttr(value: string): string {
    return value
        .replace(DANGEROUS_STYLE_PROP_RE, "$1")
        .replace(/(?:\s*;\s*)+/g, ";") // 세미콜론 런 정리
        .replace(/^;|;$/g, "")
        .trim();
}

// URI 허용 prefix — http(s), data:image/font, mailto, tel, relative(/), fragment(#)
const ALLOWED_URI_RE = /^(?:https?:|data:image\/|data:font\/|mailto:|tel:|\/|#)/i;

// href/src 류 URI 속성 — javascript:/vbscript: 등 차단 대상
const URI_ATTRIBUTES = new Set(["href", "src", "xlink:href", "data", "poster"]);

function isDangerousUri(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false; // 빈 값은 통과 (form action="" 등은 위에서 별도 제거)
    return !ALLOWED_URI_RE.test(trimmed);
}

export async function sanitizeSkinHtml(dirty: string): Promise<string> {
    // HTMLRewriter 는 Response 스트림을 처리. 입력 HTML 을 Response 로 감싸고,
    // 변환된 결과를 다시 text 로 추출한다.
    const rewriter = new HTMLRewriter()
        // 금지 태그 제거 (자식 포함)
        .on(FORBIDDEN_TAGS.join(", "), {
            element(el) {
                el.remove();
            },
        })
        // 모든 요소에 대한 속성 정화
        .on("*", {
            element(el) {
                // Cloudflare HTMLRewriter 의 attributes 는 [name, value] 튜플 이터러블이지만
                // 기본 DOM lib.dom 의 NamedNodeMap (Attr[]) 타입이 우선 매칭되므로 명시 캐스팅.
                const attrs = el.attributes as unknown as Iterable<[string, string]>;
                // 1) on* 이벤트 핸들러 및 forbidden 속성 제거
                //    2) URI 속성에 javascript:/vbscript:/file: 등 차단
                for (const [rawName, value] of attrs) {
                    const name = rawName.toLowerCase();
                    if (EVENT_HANDLER_RE.test(name) || FORBIDDEN_ATTRIBUTES.has(name)) {
                        el.removeAttribute(rawName);
                        continue;
                    }
                    if (URI_ATTRIBUTES.has(name) && isDangerousUri(value)) {
                        el.removeAttribute(rawName);
                        continue;
                    }
                    // ctrls M-7: 인라인 style 의 오버레이/리드레싱 속성 무력화.
                    if (name === "style") {
                        const cleaned = sanitizeStyleAttr(value);
                        if (cleaned) el.setAttribute(rawName, cleaned);
                        else el.removeAttribute(rawName);
                    }
                }
            },
        });

    const response = rewriter.transform(
        new Response(dirty, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    );
    return await response.text();
}
