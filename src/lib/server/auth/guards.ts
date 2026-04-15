import { error } from '@sveltejs/kit';

export function requireDbContext(locals: App.Locals) {
	if (!locals.db || !locals.tenant) {
		throw error(
			503,
			locals.runtimeError ??
				'D1 binding "DB" 를 찾을 수 없습니다. Wrangler preview/dev 환경에서 실행 중인지 확인해 주세요.'
		);
	}

	return { db: locals.db, tenant: locals.tenant };
}
