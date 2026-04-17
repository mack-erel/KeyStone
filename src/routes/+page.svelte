<script lang="ts">
import { resolve } from '$app/paths';
import { t } from '$lib/i18n.svelte';

const quickLinks = [
	{ route: '/login' as const, label: '관리자 로그인' },
	{ route: '/admin' as const, label: '관리자 콘솔' },
	{ route: '/poc' as const, label: 'Workers PoC' },
];
</script>

<main class="min-h-screen bg-gray-950 px-6 py-16 text-gray-100">
	<div class="mx-auto max-w-5xl space-y-10">
		<div class="space-y-4">
			<p class="text-sm tracking-[0.3em] text-cyan-300 uppercase">IdP Project</p>
			<h1 class="max-w-3xl text-4xl font-semibold sm:text-5xl">{t('app.title')}</h1>
			<p class="max-w-2xl text-base leading-7 text-gray-300 sm:text-lg">Cloudflare Workers + SvelteKit 기반 자체 IdP. 현재는 M0 범위인 로그인, 세션, 관리자 보호 흐름을 우선 정리하는 단계입니다.</p>
		</div>

		<div class="grid gap-4 sm:grid-cols-3">
			{#each quickLinks as link (link.route)}
				<a href={resolve(link.route)} class="rounded-2xl border border-white/10 bg-white/5 p-5 transition hover:border-cyan-300/60 hover:bg-cyan-300/10">
					<p class="text-lg font-medium">{link.label}</p>
					<p class="mt-2 text-sm text-gray-400">{resolve(link.route)}</p>
				</a>
			{/each}
		</div>
	</div>
</main>
