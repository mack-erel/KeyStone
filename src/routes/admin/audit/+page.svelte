<script lang="ts">
	import type { PageData } from './$types';
	import { t } from '$lib/i18n.svelte';

	const { data } = $props<{ data: PageData }>();
	const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
		dateStyle: 'medium',
		timeStyle: 'short'
	});

	function formatDetail(detailJson: string | null): string {
		if (!detailJson) {
			return '-';
		}

		try {
			return JSON.stringify(JSON.parse(detailJson));
		} catch {
			return detailJson;
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-gray-900">{t('admin.audit')}</h1>
	</div>

	<div class="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
		<table class="min-w-full divide-y divide-gray-200">
			<thead class="bg-gray-50">
				<tr>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						Timestamp
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						User
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						Action
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						결과
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						상세
					</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-gray-200 bg-white">
				{#if data.events.length === 0}
					<tr>
						<td colspan="5" class="px-6 py-8 text-center text-sm text-gray-500">
							감사 로그가 없습니다.
						</td>
					</tr>
				{:else}
					{#each data.events as auditEvent (auditEvent.id)}
						<tr>
							<td class="px-6 py-4 text-sm text-gray-700">
								{dateFormatter.format(auditEvent.createdAt)}
							</td>
							<td class="px-6 py-4 text-sm text-gray-700">{auditEvent.userEmail ?? '-'}</td>
							<td class="px-6 py-4 font-mono text-sm text-gray-700">{auditEvent.kind}</td>
							<td class="px-6 py-4 text-sm text-gray-700">{auditEvent.outcome}</td>
							<td class="px-6 py-4 text-sm text-gray-500">
								{formatDetail(auditEvent.detailJson)}
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</div>
