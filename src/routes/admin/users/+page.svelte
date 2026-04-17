<script lang="ts">
import { enhance } from '$app/forms';
import { resolve } from '$app/paths';
import type { ActionData, PageData } from './$types';

const { data, form } = $props<{ data: PageData; form?: ActionData }>();

const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
	dateStyle: 'medium',
	timeStyle: 'short',
});

let showCreate = $state(false);
let resetPasswordUserId = $state<string | null>(null);

const formErr = $derived((form as { error?: string } | null)?.error ?? null);
const createErr = $derived((form as { create?: boolean; error?: string } | null)?.create ? formErr : null);
const resetErr = $derived((form as { resetPassword?: boolean; error?: string } | null)?.resetPassword ? formErr : null);

const STATUS_LABEL: Record<string, string> = {
	active: '활성',
	disabled: '비활성',
	locked: '잠김',
};
const STATUS_NEXT: Record<string, { status: string; label: string }> = {
	active: { status: 'disabled', label: '비활성화' },
	disabled: { status: 'active', label: '활성화' },
	locked: { status: 'active', label: '잠금 해제' },
};
const STATUS_COLOR: Record<string, string> = {
	active: 'bg-green-100 text-green-700',
	disabled: 'bg-gray-100 text-gray-500',
	locked: 'bg-red-100 text-red-600',
};
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-gray-900">사용자 관리</h1>
		<button type="button" onclick={() => (showCreate = !showCreate)} class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700">
			{showCreate ? '취소' : '+ 사용자 추가'}
		</button>
	</div>

	<!-- 사용자 생성 폼 -->
	{#if showCreate}
		<div class="rounded-xl border border-blue-100 bg-blue-50 p-5">
			<h2 class="mb-4 font-semibold text-blue-900">새 사용자 추가</h2>

			{#if createErr}
				<div class="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
					{createErr}
				</div>
			{/if}

			<form
				method="POST"
				action="?/create"
				use:enhance={() => {
					return ({ result, update }) => {
						update();
						if (result.type === 'success') showCreate = false;
					};
				}}
				class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div>
					<label for="new-email" class="block text-xs font-medium text-gray-700">이메일 *</label>
					<input id="new-email" type="email" name="email" required class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
				</div>
				<div>
					<label for="new-username" class="block text-xs font-medium text-gray-700">아이디 (미입력 시 자동)</label>
					<input id="new-username" type="text" name="username" class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
				</div>
				<div>
					<label for="new-displayName" class="block text-xs font-medium text-gray-700">이름</label>
					<input id="new-displayName" type="text" name="displayName" class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
				</div>
				<div>
					<label for="new-role" class="block text-xs font-medium text-gray-700">역할 *</label>
					<select id="new-role" name="role" class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none">
						<option value="user">일반 사용자</option>
						<option value="admin">관리자</option>
					</select>
				</div>
				<div class="sm:col-span-2">
					<label for="new-password" class="block text-xs font-medium text-gray-700">비밀번호 * (8자 이상)</label>
					<input
						id="new-password"
						type="password"
						name="password"
						required
						minlength="8"
						class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
				</div>
				<div class="flex justify-end sm:col-span-2">
					<button type="submit" class="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"> 추가 </button>
				</div>
			</form>
		</div>
	{/if}

	<!-- 전역 에러 (create 아닌 경우) -->
	{#if formErr && !createErr && !resetErr}
		<div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
			{formErr}
		</div>
	{/if}

	<!-- 테이블 -->
	<div class="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
		<table class="min-w-full divide-y divide-gray-200">
			<thead class="bg-gray-50">
				<tr>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">아이디 / 이메일</th>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">이름</th>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">역할</th>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">상태</th>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">생성</th>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">작업</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-gray-200">
				{#if data.users.length === 0}
					<tr>
						<td colspan="6" class="px-6 py-8 text-center text-sm text-gray-500">등록된 사용자가 없습니다.</td>
					</tr>
				{:else}
					{#each data.users as user (user.id)}
						<tr class="hover:bg-gray-50">
							<td class="px-4 py-3">
								<a href={resolve(`/admin/users/${user.id}`)} class="block hover:underline">
									<p class="text-sm font-medium text-gray-900">{user.username ?? '-'}</p>
									<p class="text-xs text-gray-500">{user.email}</p>
								</a>
							</td>
							<td class="px-4 py-3 text-sm text-gray-600">{user.displayName ?? '-'}</td>

							<!-- 역할 변경 -->
							<td class="px-4 py-3">
								<form method="POST" action="?/updateRole" use:enhance>
									<input type="hidden" name="id" value={user.id} />
									<select
										name="role"
										onchange={(e) => (e.currentTarget.closest('form') as HTMLFormElement).requestSubmit()}
										class="rounded border border-gray-200 bg-transparent py-0.5 text-xs text-gray-700 focus:outline-none">
										<option value="user" selected={user.role === 'user'}>일반</option>
										<option value="admin" selected={user.role === 'admin'}>관리자</option>
									</select>
								</form>
							</td>

							<!-- 상태 배지 + 변경 -->
							<td class="px-4 py-3">
								<div class="flex items-center gap-2">
									<span class="rounded-full px-2 py-0.5 text-xs font-medium {STATUS_COLOR[user.status]}">
										{STATUS_LABEL[user.status]}
									</span>
									{#if STATUS_NEXT[user.status]}
										<form method="POST" action="?/updateStatus" use:enhance>
											<input type="hidden" name="id" value={user.id} />
											<input type="hidden" name="status" value={STATUS_NEXT[user.status].status} />
											<button type="submit" class="text-xs text-gray-400 hover:text-gray-700 hover:underline">
												{STATUS_NEXT[user.status].label}
											</button>
										</form>
									{/if}
								</div>
							</td>

							<td class="px-4 py-3 text-xs text-gray-400">{dateFormatter.format(user.createdAt)}</td>

							<!-- 작업 버튼 -->
							<td class="px-4 py-3">
								<div class="flex items-center gap-2">
									<button type="button" onclick={() => (resetPasswordUserId = resetPasswordUserId === user.id ? null : user.id)} class="text-xs text-blue-500 hover:text-blue-700">
										비밀번호 초기화
									</button>

									<form method="POST" action="?/delete" use:enhance>
										<input type="hidden" name="id" value={user.id} />
										<button
											type="submit"
											class="text-xs text-red-400 hover:text-red-600"
											onclick={(e) => {
												if (!confirm('사용자를 삭제하시겠습니까?')) e.preventDefault();
											}}>
											삭제
										</button>
									</form>
								</div>
							</td>
						</tr>

						<!-- 비밀번호 초기화 인라인 폼 -->
						{#if resetPasswordUserId === user.id}
							<tr class="bg-blue-50">
								<td colspan="6" class="px-4 py-3">
									{#if resetErr}
										<p class="mb-2 text-xs text-red-600">{resetErr}</p>
									{/if}
									<form
										method="POST"
										action="?/resetPassword"
										use:enhance={() => {
											return ({ result, update }) => {
												update();
												if (result.type === 'success') resetPasswordUserId = null;
											};
										}}
										class="flex items-center gap-2">
										<input type="hidden" name="id" value={user.id} />
										<input
											type="password"
											name="newPassword"
											required
											minlength="8"
											placeholder="새 비밀번호 (8자 이상)"
											class="rounded-md border border-gray-300 px-3 py-1 text-sm focus:border-blue-500 focus:outline-none" />
										<button type="submit" class="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"> 변경 </button>
										<button type="button" onclick={() => (resetPasswordUserId = null)} class="text-xs text-gray-400 hover:text-gray-600"> 취소 </button>
									</form>
								</td>
							</tr>
						{/if}
					{/each}
				{/if}
			</tbody>
		</table>
	</div>
</div>
