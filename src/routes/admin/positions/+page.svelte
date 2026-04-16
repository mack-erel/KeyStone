<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	const { data, form } = $props<{ data: PageData; form?: ActionData }>();

	let showCreate = $state(false);
	let editId = $state<string | null>(null);

	const err = $derived((form as { error?: string } | null)?.error ?? null);
	const createErr = $derived(
		(form as { create?: boolean; error?: string } | null)?.create ? err : null
	);
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-gray-900">직급 관리</h1>
		<button
			type="button"
			onclick={() => (showCreate = !showCreate)}
			class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
		>
			{showCreate ? '취소' : '+ 직급 추가'}
		</button>
	</div>

	{#if showCreate}
		<div class="rounded-xl border border-blue-100 bg-blue-50 p-5">
			<h2 class="mb-4 font-semibold text-blue-900">새 직급 추가</h2>
			{#if createErr}
				<p class="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
					{createErr}
				</p>
			{/if}
			<form
				method="POST"
				action="?/create"
				use:enhance={() =>
					({ result, update }) => {
						update();
						if (result.type === 'success') showCreate = false;
					}}
				class="grid grid-cols-1 gap-3 sm:grid-cols-3"
			>
				<div>
					<label for="pos-name" class="block text-xs font-medium text-gray-700">직급명 *</label>
					<input
						id="pos-name"
						type="text"
						name="name"
						required
						placeholder="예: 과장"
						class="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
					/>
				</div>
				<div>
					<label for="pos-code" class="block text-xs font-medium text-gray-700">코드</label>
					<input
						id="pos-code"
						type="text"
						name="code"
						placeholder="예: MGR"
						class="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
					/>
				</div>
				<div>
					<label for="pos-level" class="block text-xs font-medium text-gray-700"
						>레벨 (높을수록 고위)</label
					>
					<input
						id="pos-level"
						type="number"
						name="level"
						value="0"
						class="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
					/>
				</div>
				<div class="flex justify-end sm:col-span-3">
					<button
						type="submit"
						class="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
						>추가</button
					>
				</div>
			</form>
		</div>
	{/if}

	<div class="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
		<table class="min-w-full divide-y divide-gray-200">
			<thead class="bg-gray-50">
				<tr>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>직급명</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>코드</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>레벨</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>작업</th
					>
				</tr>
			</thead>
			<tbody class="divide-y divide-gray-200">
				{#if data.positions.length === 0}
					<tr
						><td colspan="4" class="px-6 py-8 text-center text-sm text-gray-500"
							>등록된 직급이 없습니다.</td
						></tr
					>
				{:else}
					{#each data.positions as pos (pos.id)}
						<tr class="hover:bg-gray-50">
							{#if editId === pos.id}
								<td colspan="3" class="px-4 py-3">
									<form
										method="POST"
										action="?/update"
										use:enhance={() =>
											({ result, update }) => {
												update();
												if (result.type === 'success') editId = null;
											}}
										class="flex flex-wrap items-center gap-2"
									>
										<input type="hidden" name="id" value={pos.id} />
										<input
											type="text"
											name="name"
											value={pos.name}
											required
											class="w-32 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none"
										/>
										<input
											type="text"
											name="code"
											value={pos.code ?? ''}
											placeholder="코드"
											class="w-24 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none"
										/>
										<input
											type="number"
											name="level"
											value={pos.level}
											class="w-20 rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none"
										/>
										<button
											type="submit"
											class="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700"
											>저장</button
										>
										<button
											type="button"
											onclick={() => (editId = null)}
											class="text-xs text-gray-400 hover:text-gray-600">취소</button
										>
									</form>
								</td>
							{:else}
								<td class="px-4 py-3 text-sm font-medium text-gray-900">{pos.name}</td>
								<td class="px-4 py-3 text-sm text-gray-500">{pos.code ?? '-'}</td>
								<td class="px-4 py-3 text-sm text-gray-500">{pos.level}</td>
							{/if}
							<td class="px-4 py-3">
								<div class="flex gap-2">
									<button
										type="button"
										onclick={() => (editId = editId === pos.id ? null : pos.id)}
										class="text-xs text-blue-500 hover:text-blue-700">수정</button
									>
									<form method="POST" action="?/delete" use:enhance>
										<input type="hidden" name="id" value={pos.id} />
										<button
											type="submit"
											class="text-xs text-red-400 hover:text-red-600"
											onclick={(e) => {
												if (!confirm('삭제하시겠습니까?')) e.preventDefault();
											}}>삭제</button
										>
									</form>
								</div>
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</div>
