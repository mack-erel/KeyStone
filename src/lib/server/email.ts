import nodemailer from "nodemailer";
import { env } from "$env/dynamic/private";

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

async function send(to: string, subject: string, html: string): Promise<void> {
    const smtp = getSmtpConfig();
    if (!smtp) throw new Error("SMTP 설정이 없습니다.");

    const transporter = nodemailer.createTransport({
        host: smtp.hostname,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.username, pass: smtp.password },
    });
    transporter.setMaxListeners(20);

    try {
        await transporter.sendMail({ from: smtp.senderAddress, to, subject, html });
    } finally {
        transporter.close();
    }
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

export async function sendFindIdEmail(to: string, username: string): Promise<void> {
    const html = baseHtml(
        "아이디 확인",
        `<p>요청하신 아이디 정보입니다.</p>
<p style="font-size:20px;font-weight:700;margin:24px 0;">${escapeHtml(username)}</p>`,
    );
    await send(to, "아이디 안내", html);
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
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
    await send(to, "비밀번호 재설정 안내", html);
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
