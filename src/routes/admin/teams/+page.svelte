<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	const { data, form } = $props<{ data: PageData; form?: ActionData }>();

	let showCreate = $state(false);
	let editId = $state<string | null>(null);

	const err = $derived((form as { error?: string } | null)?.error ?? null);
	const createErr = $derived((form as { create?: boolean; error?: string } | null)?.create ? err : null);

	const STATUS_COLOR: Record<string, string> = { active: 'bg-green-100 text-green-700', inactive: 'bg-gray-100 text-gray-500' };
	const STATUS_LABEL: Record<string, string> = { active: '활성', inactive: '비활성' };
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-gray-900">팀 관리</h1>
		<button type="button" onclick={() => (showCreate = !showCreate)} class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700">
			{showCreate ? '취소' : '+ 팀 추가'}
		</button>
	</div>

	{#if showCreate}
		<div class="rounded-xl border border-blue-100 bg-blue-50 p-5">
			<h2 class="mb-4 font-semibold text-blue-900">새 팀 추가</h2>
			{#if createErr}
				<p class="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{createErr}</p>
			{/if}
			<form
				method="POST"
				action="?/create"
				use:enhance={() => ({ result, update }) => { update(); if (result.type === 'success') showCreate = false; }}
				class="grid grid-cols-1 gap-3 sm:grid-cols-2"
			>
				<div>
					<label class="block text-xs font-medium text-gray-700">팀명 *</label>
					<input type="text" name="name" required placeholder="예: 백엔드팀" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
				</div>
				<div>
					<label class="block text-xs font-medium text-gray-700">코드</label>
					<input type="text" name="code" placeholder="예: BE" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
				</div>
				<div>
					<label class="block text-xs font-medium text-gray-700">소속 부서</label>
					<select name="departmentId" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none">
						<option value="">없음 (독립 팀)</option>
						{#each data.allDepts as dept (dept.id)}
							<option value={dept.id}>{dept.name}</option>
						{/each}
					</select>
				</div>
				<div>
					<label class="block text-xs font-medium text-gray-700">설명</label>
					<input type="text" name="description" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
				</div>
				<div class="sm:col-span-2 flex justify-end">
					<button type="submit" class="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700">추가</button>
				</div>
			</form>
		</div>
	{/if}

	{#if err && !createErr}
		<p class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</p>
	{/if}

	<div class="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
		<table class="min-w-full divide-y divide-gray-200">
			<thead class="bg-gray-50">
				<tr>
					<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">팀명</th>
					<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">코드</th>
					<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">소속 부서</th>
					<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">상태</th>
					<th class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">작업</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-gray-200">
				{#if data.teams.length === 0}
					<tr><td colspan="5" class="px-6 py-8 text-center text-sm text-gray-500">등록된 팀이 없습니다.</td></tr>
				{:else}
					{#each data.teams as team (team.id)}
						<tr class="hover:bg-gray-50">
							{#if editId === team.id}
								<td colspan="4" class="px-4 py-3">
									<form method="POST" action="?/update" use:enhance={() => ({ result, update }) => { update(); if (result.type === 'success') editId = null; }} class="grid grid-cols-2 gap-2 sm:grid-cols-4">
										<input type="hidden" name="id" value={team.id} />
										<input type="text" name="name" value={team.name} required placeholder="팀명" class="rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none" />
										<input type="text" name="code" value={team.code ?? ''} placeholder="코드" class="rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none" />
										<select name="departmentId" class="rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none">
											<option value="">없음 (독립 팀)</option>
											{#each data.allDepts as d (d.id)}
												<option value={d.id} selected={team.departmentId === d.id}>{d.name}</option>
											{/each}
										</select>
										<select name="status" class="rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none">
											<option value="active" selected={team.status === 'active'}>활성</option>
											<option value="inactive" selected={team.status === 'inactive'}>비활성</option>
										</select>
										<div class="col-span-2 sm:col-span-4 flex gap-2">
											<button type="submit" class="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700">저장</button>
											<button type="button" onclick={() => editId = null} class="text-xs text-gray-400 hover:text-gray-600">취소</button>
										</div>
									</form>
								</td>
							{:else}
								<td class="px-4 py-3 text-sm font-medium text-gray-900">{team.name}</td>
								<td class="px-4 py-3 text-sm text-gray-500">{team.code ?? '-'}</td>
								<td class="px-4 py-3 text-sm text-gray-500">{team.departmentName ?? '-'}</td>
								<td class="px-4 py-3">
									<span class="rounded-full px-2 py-0.5 text-xs font-medium {STATUS_COLOR[team.status]}">{STATUS_LABEL[team.status]}</span>
								</td>
							{/if}
							<td class="px-4 py-3">
								<div class="flex gap-2">
									<button type="button" onclick={() => editId = editId === team.id ? null : team.id} class="text-xs text-blue-500 hover:text-blue-700">수정</button>
									<form method="POST" action="?/delete" use:enhance>
										<input type="hidden" name="id" value={team.id} />
										<button type="submit" class="text-xs text-red-400 hover:text-red-600" onclick={(e) => { if (!confirm('삭제하시겠습니까?')) e.preventDefault(); }}>삭제</button>
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
