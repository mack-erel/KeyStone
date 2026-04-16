<script lang="ts">
	import type { PageData } from './$types';
	import { t } from '$lib/i18n.svelte';

	const { data } = $props<{ data: PageData }>();
</script>

<div class="space-y-6">
	<div class="space-y-2">
		<h1 class="text-2xl font-bold text-gray-900">{t('admin.title')}</h1>
		<p class="text-sm text-gray-500">기본 tenant 의 현재 운영 현황을 빠르게 확인할 수 있습니다.</p>
	</div>

	<div>
		<p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">인증 프로토콜</p>
		<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
			<div class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
				<h3 class="text-sm font-medium text-gray-500">{t('admin.users')}</h3>
				<p class="mt-2 text-3xl font-bold text-gray-900">{data.counts.users}</p>
			</div>
			<div class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
				<h3 class="text-sm font-medium text-gray-500">{t('admin.oidc_clients')}</h3>
				<p class="mt-2 text-3xl font-bold text-gray-900">{data.counts.oidcClients}</p>
			</div>
			<div class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
				<h3 class="text-sm font-medium text-gray-500">{t('admin.saml_sps')}</h3>
				<p class="mt-2 text-3xl font-bold text-gray-900">{data.counts.samlSps}</p>
			</div>
			<div class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
				<h3 class="text-sm font-medium text-gray-500">{t('admin.signing_keys')}</h3>
				<p class="mt-2 text-3xl font-bold text-gray-900">{data.counts.signingKeys}</p>
			</div>
			<div class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
				<h3 class="text-sm font-medium text-gray-500">{t('admin.audit')}</h3>
				<p class="mt-2 text-3xl font-bold text-gray-900">{data.counts.auditEvents}</p>
			</div>
		</div>
	</div>

	<div>
		<p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400">{t('admin.org')}</p>
		<div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
			<div class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
				<h3 class="text-sm font-medium text-gray-500">{t('admin.departments')}</h3>
				<p class="mt-2 text-3xl font-bold text-gray-900">{data.counts.departments}</p>
			</div>
			<div class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
				<h3 class="text-sm font-medium text-gray-500">{t('admin.teams')}</h3>
				<p class="mt-2 text-3xl font-bold text-gray-900">{data.counts.teams}</p>
			</div>
			<div class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
				<h3 class="text-sm font-medium text-gray-500">{t('admin.positions')}</h3>
				<p class="mt-2 text-3xl font-bold text-gray-900">{data.counts.positions}</p>
			</div>
		</div>
	</div>
</div>
