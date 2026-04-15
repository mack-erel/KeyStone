<script lang="ts">
	import type { PageData } from './$types';
	import { t } from '$lib/i18n.svelte';

	const { data } = $props<{ data: PageData }>();
	const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
		dateStyle: 'medium',
		timeStyle: 'short'
	});
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-gray-900">{t('admin.users')}</h1>
	</div>

	<div class="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
		<table class="min-w-full divide-y divide-gray-200">
			<thead class="bg-gray-50">
				<tr>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						{t('login.email')}
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						이름
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						역할
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						상태
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						생성 시각
					</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-gray-200 bg-white">
				{#if data.users.length === 0}
					<tr>
						<td colspan="5" class="px-6 py-8 text-center text-sm text-gray-500">
							등록된 사용자가 없습니다.
						</td>
					</tr>
				{:else}
					{#each data.users as user (user.id)}
						<tr>
							<td class="px-6 py-4 text-sm text-gray-900">{user.email}</td>
							<td class="px-6 py-4 text-sm text-gray-600">{user.displayName ?? '-'}</td>
							<td class="px-6 py-4 text-sm text-gray-600">{user.role}</td>
							<td class="px-6 py-4 text-sm text-gray-600">{user.status}</td>
							<td class="px-6 py-4 text-sm text-gray-600">
								{dateFormatter.format(user.createdAt)}
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</div>
