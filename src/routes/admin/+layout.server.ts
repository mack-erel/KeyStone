import { redirect } from "@sveltejs/kit";
import type { LayoutServerLoad } from "./$types";
import { requireDbContext } from "$lib/server/auth/guards";

export const load: LayoutServerLoad = async ({ locals, url }) => {
    // 관리자 로그인 페이지는 인증 없이 접근 가능
    if (url.pathname === "/admin/login") {
        return { currentUser: null };
    }

    requireDbContext(locals);

    if (!locals.user) {
        throw redirect(303, `/admin/login?redirectTo=${encodeURIComponent(url.pathname + url.search)}`);
    }

    if (locals.user.role !== "admin") {
        throw redirect(303, "/");
    }

    return {
        currentUser: {
            email: locals.user.email,
            displayName: locals.user.displayName,
            role: locals.user.role,
        },
    };
};
