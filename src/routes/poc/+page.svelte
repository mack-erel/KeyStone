<script lang="ts">
import { resolve } from '$app/paths';

const pocs = [
	{ route: '/poc/rs256' as const, title: 'RS256 JWT (WebCrypto)', status: 'ok' },
	{
		route: '/poc/argon2' as const,
		title: 'Password hashing (PBKDF2 fallback → argon2id)',
		status: 'partial',
	},
	{
		route: '/poc/saml-sign' as const,
		title: 'SAML Assertion 서명 (c14n blocker)',
		status: 'partial',
	},
];
</script>

<main class="mx-auto max-w-2xl p-8">
	<h1 class="mb-6 text-2xl font-semibold">Workers 환경 PoC</h1>
	<p class="mb-4 text-sm text-gray-600">킥오프 M0 사전 점검. 각 엔드포인트는 GET 요청 시 JSON 으로 결과를 반환.</p>
	<ul class="space-y-3">
		{#each pocs as p (p.route)}
			<li class="rounded border p-3">
				<a href={resolve(p.route)} class="font-mono text-blue-600 hover:underline">{resolve(p.route)}</a>
				<span class="ml-2">{p.title}</span>
				<span class="ml-2 rounded px-2 py-0.5 text-xs" class:bg-green-100={p.status === 'ok'} class:bg-yellow-100={p.status === 'partial'}>
					{p.status}
				</span>
			</li>
		{/each}
	</ul>
</main>
