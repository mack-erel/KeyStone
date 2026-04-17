import type { Handle } from '@sveltejs/kit';
import { ensureAuthBaseline } from '$lib/server/auth/bootstrap';
import { SESSION_COOKIE_NAME, SESSION_TOUCH_INTERVAL_MS } from '$lib/server/auth/constants';
import { getRuntimeConfig } from '$lib/server/auth/runtime';
import { clearSessionCookie, getSessionContext, touchSession } from '$lib/server/auth/session';
import { getDb } from '$lib/server/db';

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.db = undefined;
	event.locals.tenant = null;
	event.locals.session = null;
	event.locals.user = null;
	event.locals.runtimeConfig = getRuntimeConfig(event.platform);
	event.locals.runtimeError = null;

	// baseline 쿼리가 불필요한 경로 (정적 메타데이터, 헬스체크)
	const path = event.url.pathname;
	const skipBaseline =
		path.startsWith('/.well-known/') ||
		path === '/api/health' ||
		path === '/favicon.ico' ||
		path === '/robots.txt';

	try {
		if (event.platform?.env?.DB) {
			const db = await getDb(event.platform);
			event.locals.db = db;
			event.locals.tenant = skipBaseline ? null : await ensureAuthBaseline(db, event.platform);

			const sessionToken = event.cookies.get(SESSION_COOKIE_NAME);

			if (sessionToken) {
				const sessionContext = await getSessionContext(db, sessionToken);

				if (sessionContext) {
					event.locals.session = sessionContext.session;
					event.locals.user = sessionContext.user;

					if (
						Date.now() - sessionContext.session.lastSeenAt.getTime() >=
						SESSION_TOUCH_INTERVAL_MS
					) {
						const now = new Date();
						await touchSession(db, sessionContext.session.id, now);
						event.locals.session.lastSeenAt = now;
					}
				} else {
					clearSessionCookie(event.cookies, event.url);
				}
			}
		}
	} catch (error) {
		event.locals.runtimeError =
			error instanceof Error ? error.message : '인증 컨텍스트 초기화 중 오류가 발생했습니다.';
		console.error(event.locals.runtimeError, error);
	}

	const response = await resolve(event);

	// ── 보안 헤더 ──────────────────────────────────────────────────────────────
	// Clickjacking 방지
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('X-Content-Type-Options', 'nosniff');

	// Referrer 정책
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

	// HSTS (HTTPS 강제, 1년)
	response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

	// Permissions Policy — 불필요한 브라우저 기능 비활성화
	response.headers.set(
		'Permissions-Policy',
		'camera=(), microphone=(), geolocation=(), payment=()'
	);

	// Content-Security-Policy
	// - 기본 self only
	// - 스타일·폰트: self + data: (Tailwind 인라인 스타일 대응)
	// - 스크립트: self only (SvelteKit hydration)
	// - frame-ancestors: none (X-Frame-Options 이중 설정)
	// - form-action: self (SAML ACS POST 예외는 별도 처리 불필요 — 서버→SP 방향)
	const csp = [
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline'", // SvelteKit SSR 인라인 스크립트 필요
		"style-src 'self' 'unsafe-inline'", // Tailwind 인라인 스타일
		"img-src 'self' data:",
		"font-src 'self' data:",
		"connect-src 'self'",
		"frame-ancestors 'none'",
		"form-action 'self' https:", // SAML ACS POST 허용 (SP는 HTTPS 외부 도메인)
		"base-uri 'self'",
		"object-src 'none'"
	].join('; ');
	response.headers.set('Content-Security-Policy', csp);

	return response;
};
