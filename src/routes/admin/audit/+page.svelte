<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import type { PageData } from './$types';

	const { data } = $props<{ data: PageData }>();

	const dateTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
		dateStyle: 'medium',
		timeStyle: 'short'
	});

	let kindFilter = $state(untrack(() => data.filters.kind ?? ''));
	let outcomeFilter = $state(untrack(() => data.filters.outcome ?? ''));

	function applyFilters() {
		const params = new URLSearchParams(page.url.searchParams);
		if (kindFilter) params.set('kind', kindFilter);
		else params.delete('kind');
		if (outcomeFilter) params.set('outcome', outcomeFilter);
		else params.delete('outcome');
		params.delete('cursor');
		goto(`?${params.toString()}`, { replaceState: true });
	}

	function resetFilters() {
		kindFilter = '';
		outcomeFilter = '';
		goto('?', { replaceState: true });
	}

	function goNext() {
		if (data.nextCursor === null) return;
		const params = new URLSearchParams(page.url.searchParams);
		params.set('cursor', String(data.nextCursor));
		goto(`?${params.toString()}`);
	}

	function formatDetail(detailJson: string | null): string {
		if (!detailJson) return '—';
		try {
			return JSON.stringify(JSON.parse(detailJson), null, 0);
		} catch {
			return detailJson;
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-gray-900">감사 로그</h1>
		<span class="text-sm text-gray-500">{data.events.length}건 표시 (페이지 {data.pageSize}건)</span>
	</div>

	<!-- 필터 -->
	<div class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
		<div class="flex flex-wrap items-end gap-3">
			<div>
				<label for="f-kind" class="block text-xs font-medium text-gray-600">이벤트 종류</label>
				<select
					id="f-kind"
					bind:value={kindFilter}
					class="mt-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
				>
					<option value="">전체</option>
					{#each data.kinds as k}
						<option value={k}>{k}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for="f-outcome" class="block text-xs font-medium text-gray-600">결과</label>
				<select
					id="f-outcome"
					bind:value={outcomeFilter}
					class="mt-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
				>
					<option value="">전체</option>
					<option value="success">성공</option>
					<option value="failure">실패</option>
				</select>
			</div>
			<div class="flex gap-2">
				<button
					type="button"
					onclick={applyFilters}
					class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
				>
					적용
				</button>
				<button
					type="button"
					onclick={resetFilters}
					class="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
				>
					초기화
				</button>
			</div>
		</div>
	</div>

	<!-- 테이블 -->
	<div class="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
		<table class="min-w-full divide-y divide-gray-200">
			<thead class="bg-gray-50">
				<tr>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>시각</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>사용자</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>이벤트</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>결과</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>IP</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>상세</th
					>
				</tr>
			</thead>
			<tbody class="divide-y divide-gray-200">
				{#if data.events.length === 0}
					<tr>
						<td colspan="6" class="px-6 py-8 text-center text-sm text-gray-500"
							>감사 로그가 없습니다.</td
						>
					</tr>
				{:else}
					{#each data.events as ev (ev.id)}
						<tr class="hover:bg-gray-50">
							<td class="px-4 py-3 text-xs whitespace-nowrap text-gray-500"
								>{dateTimeFormatter.format(ev.createdAt)}</td
							>
							<td class="px-4 py-3 text-xs text-gray-600">{ev.userEmail ?? '—'}</td>
							<td class="px-4 py-3 font-mono text-xs text-gray-800">{ev.kind}</td>
							<td class="px-4 py-3">
								<span
									class="rounded-full px-2 py-0.5 text-xs font-medium {ev.outcome === 'success'
										? 'bg-green-100 text-green-700'
										: 'bg-red-100 text-red-600'}"
								>
									{ev.outcome === 'success' ? '성공' : '실패'}
								</span>
							</td>
							<td class="px-4 py-3 font-mono text-xs text-gray-400">{ev.ip ?? '—'}</td>
							<td
								class="max-w-[280px] truncate px-4 py-3 font-mono text-xs text-gray-500"
								title={ev.detailJson ?? ''}
							>
								{formatDetail(ev.detailJson)}
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>

	{#if data.nextCursor !== null}
		<div class="flex justify-end">
			<button
				type="button"
				onclick={goNext}
				class="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
			>
				다음 페이지 →
			</button>
		</div>
	{/if}
</div>
