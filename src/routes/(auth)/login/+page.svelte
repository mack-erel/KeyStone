<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { t } from '$lib/i18n.svelte';

	const { data, form } = $props<{ data: PageData; form?: ActionData }>();
</script>

<div class="flex min-h-screen items-center justify-center bg-gray-50 p-4">
	<div class="w-full max-w-[420px] rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
		<div class="mb-6 space-y-2 text-center">
			<h1 class="text-2xl font-bold text-gray-900">{t('app.title')}</h1>
			<p class="text-sm leading-6 text-gray-500">M0 관리자 진입용 로컬 계정 로그인입니다.</p>
		</div>

		{#if !data.dbReady && data.runtimeError}
			<div
				class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
			>
				{data.runtimeError}
			</div>
		{/if}

		{#if form?.error}
			<div class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
				{form.error}
			</div>
		{/if}

		<form method="POST" class="space-y-4">
			<input type="hidden" name="redirectTo" value={form?.redirectTo ?? data.redirectTo ?? ''} />

			<div>
				<label for="username" class="block text-sm font-medium text-gray-700">
					{t('login.username')}
				</label>
				<input
					type="text"
					name="username"
					id="username"
					required
					autocomplete="username"
					value={form?.username ?? ''}
					class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:ring-blue-500 focus:outline-none sm:text-sm"
				/>
			</div>

			<div>
				<label for="password" class="block text-sm font-medium text-gray-700">
					{t('login.password')}
				</label>
				<input
					type="password"
					name="password"
					id="password"
					required
					autocomplete="current-password"
					class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:ring-blue-500 focus:outline-none sm:text-sm"
				/>
			</div>

			<button
				type="submit"
				class="flex w-full justify-center rounded-md border border-transparent bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none"
			>
				{t('login.submit')}
			</button>
		</form>
	</div>
</div>
