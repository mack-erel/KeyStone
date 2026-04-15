<script lang="ts">
	import type { PageData } from './$types';
	import { t } from '$lib/i18n.svelte';

	const { data } = $props<{ data: PageData }>();
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-gray-900">{t('admin.saml_sps')}</h1>
	</div>

	<div class="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
		<table class="min-w-full divide-y divide-gray-200">
			<thead class="bg-gray-50">
				<tr>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						Entity ID
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						Name
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						ACS URL
					</th>
					<th
						class="px-6 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
					>
						상태
					</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-gray-200 bg-white">
				{#if data.sps.length === 0}
					<tr>
						<td colspan="4" class="px-6 py-8 text-center text-sm text-gray-500">
							등록된 SAML SP 가 없습니다.
						</td>
					</tr>
				{:else}
					{#each data.sps as sp (sp.id)}
						<tr>
							<td class="px-6 py-4 font-mono text-sm text-gray-900">{sp.entityId}</td>
							<td class="px-6 py-4 text-sm text-gray-700">{sp.name}</td>
							<td class="px-6 py-4 text-sm text-gray-600">{sp.acsUrl}</td>
							<td class="px-6 py-4 text-sm text-gray-600">
								{sp.enabled ? 'enabled' : 'disabled'}
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</div>
