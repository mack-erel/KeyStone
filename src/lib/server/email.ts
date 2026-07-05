import { env } from "$env/dynamic/private";

// ── 발송 코어: 런타임 분기 ────────────────────────────────────────────────────
// B6: nodemailer(raw TCP SMTP)는 Cloudflare Workers 런타임에서 동작하지 않는다
// (net/tls 미지원). 따라서 발송 경로를 런타임별로 분기한다.
//   - Cloudflare Workers: send_email 바인딩(platform.env.EMAIL)이 있으면
//     Cloudflare Email Sending 으로 발송한다. 이 바인딩은 sender 도메인만
//     온보딩되어 있으면 "임의 외부 수신자"에게 트랜잭션 메일을 보낼 수 있다
//     (비밀번호 재설정/아이디 찾기에 적합). 수신자 검증이 필요한 것은 구
//     Email Routing 의 forward 이지, Email Sending 발송 경로가 아니다.
//   - 그 외(Node/adapter-node): 기존 nodemailer(SMTP)로 발송한다.
//     nodemailer 는 top-level import 를 제거하고 **동적 import** 로 바꿔
//     Workers 번들/런타임에 net/tls 의존이 끌려들어가지 않게 한다.

type EnvLookup = Record<string, unknown>;

// send_email 바인딩(SendEmail)은 workerd 런타임이 주입하며 worker-configuration.d.ts
// 에 전역 타입으로 존재한다. platform.env 는 Env 확장이라 아직 EMAIL 이 선언돼
// 있지 않을 수 있으므로 방어적으로 조회한다.
function getEmailBinding(platform: App.Platform | undefined): SendEmail | undefined {
    const binding = (platform?.env as EnvLookup | undefined)?.EMAIL as SendEmail | undefined;
    // send() 메서드가 존재해야 유효한 바인딩으로 간주.
    return binding && typeof binding.send === "function" ? binding : undefined;
}

function readEnv(platform: App.Platform | undefined, key: string): string | undefined {
    const fromPlatform = (platform?.env as EnvLookup | undefined)?.[key];
    if (typeof fromPlatform === "string" && fromPlatform.length > 0) return fromPlatform;
    // $env/dynamic/private 는 Workers 에서 platform.env, Node 에서 process.env 를 반영한다.
    const fromEnv = (env as EnvLookup)?.[key];
    return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : undefined;
}

// Cloudflare Email 발송에 필요한 sender 정보. from 주소는 반드시 Email Sending 에
// 온보딩된 도메인이어야 한다(wrangler email sending enable <domain>). 미설정이면
// null 을 돌려 상위에서 "설정 없음"으로 처리한다.
function getCloudflareFrom(platform: App.Platform | undefined): { email: string; name: string } | null {
    const email = readEnv(platform, "EMAIL_FROM");
    if (!email) return null;
    const name = readEnv(platform, "EMAIL_FROM_NAME") ?? "KeyStone";
    return { email, name };
}

function getSmtpConfig() {
    const hostname = env.SMTP_HOSTNAME;
    const port = env.SMTP_PORTNUMB;
    const username = env.SMTP_USERNAME;
    const password = env.SMTP_PASSWORD;
    if (!hostname || !port || !username || !password) return null;
    const enc = (env.SMTP_ENC_TYPE ?? "tls").toLowerCase();
    return {
        hostname,
        port: parseInt(port, 10),
        username,
        password,
        secure: enc === "ssl" || parseInt(port, 10) === 465,
        senderAddress: env.SMTP_SENDMAIL ?? username,
    };
}

// 일부 메일 클라이언트는 text/plain 만 렌더링하고, 본문에 text 파트가 있으면
// 스팸 점수에도 유리하다(스킬 deliverability 권장). HTML 을 최소한으로 정제해
// text 대체본을 만든다 — 정확한 렌더링이 아니라 fallback 용도.
function htmlToText(html: string): string {
    return html
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}

async function sendViaNodemailer(to: string, subject: string, html: string, text: string): Promise<void> {
    const smtp = getSmtpConfig();
    if (!smtp) throw new Error("이메일 발송 설정이 없습니다. (SMTP_* 미설정)");

    // 동적 import: Workers 번들에 net/tls 의존을 top-level 로 끌어오지 않도록.
    const { default: nodemailer } = await import("nodemailer");
    const transporter = nodemailer.createTransport({
        host: smtp.hostname,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.username, pass: smtp.password },
    });
    transporter.setMaxListeners(20);

    try {
        await transporter.sendMail({ from: smtp.senderAddress, to, subject, html, text });
    } finally {
        transporter.close();
    }
}

async function send(to: string, subject: string, html: string, platform: App.Platform | undefined): Promise<void> {
    const text = htmlToText(html);

    // 1) Cloudflare Workers 경로 — send_email 바인딩이 있으면 최우선.
    const emailBinding = getEmailBinding(platform);
    if (emailBinding) {
        const from = getCloudflareFrom(platform);
        if (!from) throw new Error("이메일 발송 설정이 없습니다. (EMAIL_FROM 미설정 — Email Sending 온보딩 도메인 주소 필요)");
        await emailBinding.send({
            to,
            from: { email: from.email, name: from.name },
            subject,
            html,
            text,
        });
        return;
    }

    // 2) Node(adapter-node) 경로 — nodemailer(SMTP). 동적 import.
    await sendViaNodemailer(to, subject, html, text);
}

// ctrls H-MAIL-1: 이메일 본문 템플릿에 들어가는 동적 값들은 HTML/attribute
// 컨텍스트 escape 가 필요하다. 정책 변경으로 username 정규식이 완화되거나
// resetUrl 의 형식 검증을 우회한 입력이 들어와도 HTML 인젝션이 발생하지 않도록
// 모든 보간 지점에서 escape.
function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// resetUrl 처럼 href 컨텍스트에 들어가는 절대 URL 은 scheme 도 검증해야 한다.
// http/https 외 (javascript:, data:, file: 등) 는 거부.
function safeAbsoluteUrl(url: string): string | null {
    try {
        const u = new URL(url);
        if (u.protocol !== "https:" && u.protocol !== "http:") return null;
        return u.toString();
    } catch {
        return null;
    }
}

function baseHtml(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="ko">
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#111;">
  <h2 style="margin-bottom:16px;">${escapeHtml(title)}</h2>
  ${body}
  <p style="margin-top:32px;color:#71717a;font-size:13px;">본인이 요청하지 않았다면 이 이메일을 무시해 주세요.</p>
</body>
</html>`;
}

export async function sendFindIdEmail(to: string, username: string, platform?: App.Platform): Promise<void> {
    const html = baseHtml(
        "아이디 확인",
        `<p>요청하신 아이디 정보입니다.</p>
<p style="font-size:20px;font-weight:700;margin:24px 0;">${escapeHtml(username)}</p>`,
    );
    await send(to, "아이디 안내", html, platform);
}

export async function sendPasswordResetEmail(to: string, resetUrl: string, platform?: App.Platform): Promise<void> {
    const safeUrl = safeAbsoluteUrl(resetUrl);
    if (!safeUrl) {
        // 잘못된 URL 형식이면 메일 발송 자체 거부 — silent skip 으로 user enumeration 차단.
        console.error("[email] sendPasswordResetEmail: 잘못된 resetUrl scheme — 발송 취소");
        return;
    }
    const html = baseHtml(
        "비밀번호 재설정",
        `<p>아래 버튼을 클릭하여 비밀번호를 재설정하세요. 링크는 1시간 동안 유효합니다.</p>
<p style="margin:28px 0;">
  <a href="${escapeHtml(safeUrl)}" style="background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;">비밀번호 재설정</a>
</p>`,
    );
    await send(to, "비밀번호 재설정 안내", html, platform);
}

export async function generateToken(): Promise<{ token: string; tokenHash: string }> {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const tokenHash = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
    return { token, tokenHash };
}

export async function hashToken(token: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function maskUsername(username: string): string {
    if (!username) return "";
    if (username.length === 1) return "*";
    if (username.length === 2) return "**";
    return username.slice(0, 1) + "*".repeat(username.length - 1);
}
