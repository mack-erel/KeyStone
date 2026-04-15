import { redirect } from '@sveltejs/kit';
import type { Actions } from './$types';

export const actions: Actions = {
  default: async () => {
    // 로그아웃 로직은 추후 구현
    throw redirect(303, '/');
  }
};
