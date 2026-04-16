<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	import type { LdapProviderConfig } from '$lib/server/ldap/types';

	const { data, form } = $props<{ data: PageData; form?: ActionData }>();

	const dateFormatter = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' });

	let showCreate = $state(false);
	let editingId = $state<string | null>(null);

	const createErr = $derived(
		(form as { create?: boolean; error?: string } | null)?.create
			? ((form as { error?: string } | null)?.error ?? null)
			: null
	);
	const globalErr = $derived(
		createErr ? null : ((form as { error?: string } | null)?.error ?? null)
	);

	function parseConfig(configJson: string | null): LdapProviderConfig {
		try {
			return JSON.parse(configJson ?? '{}') as LdapProviderConfig;
		} catch {
			return { host: '', port: 389, baseDN: '', userDnPattern: '', tlsMode: 'none' };
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-gray-900">LDAP 프로바이더</h1>
		<button
			type="button"
			onclick={() => {
				showCreate = !showCreate;
				editingId = null;
			}}
			class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
		>
			{showCreate ? '취소' : '+ 프로바이더 추가'}
		</button>
	</div>

	{#if (form as { create?: boolean } | null)?.create && !createErr}
		<div class="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
			LDAP 프로바이더가 추가되었습니다. 테스트 후 활성화하세요.
		</div>
	{/if}

	{#if (form as { update?: boolean } | null)?.update}
		<div class="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
			저장되었습니다.
		</div>
	{/if}

	{#if globalErr}
		<div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
			{globalErr}
		</div>
	{/if}

	<!-- 생성 폼 -->
	{#if showCreate}
		<div class="rounded-xl border border-blue-100 bg-blue-50 p-5">
			<h2 class="mb-4 font-semibold text-blue-900">새 LDAP 프로바이더</h2>
			{#if createErr}
				<div class="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
					{createErr}
				</div>
			{/if}
			<form
				method="POST"
				action="?/create"
				use:enhance={() =>
					({ result, update }) => {
						update();
						if (result.type === 'success') showCreate = false;
					}}
				class="space-y-4"
			>
				<!-- 기본 정보 -->
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<div>
						<label for="c-name" class="block text-xs font-medium text-gray-700">이름 *</label>
						<input
							id="c-name"
							type="text"
							name="name"
							required
							placeholder="사내 LDAP"
							class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
						/>
					</div>
					<div>
						<label for="c-tlsMode" class="block text-xs font-medium text-gray-700">TLS 모드</label>
						<select
							id="c-tlsMode"
							name="tlsMode"
							class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
						>
							<option value="none">없음 (ldap://)</option>
							<option value="tls">TLS (ldaps://)</option>
							<option value="starttls">STARTTLS</option>
						</select>
					</div>
					<div>
						<label for="c-host" class="block text-xs font-medium text-gray-700">호스트 *</label>
						<input
							id="c-host"
							type="text"
							name="host"
							required
							placeholder="ldap.example.com"
							class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
						/>
					</div>
					<div>
						<label for="c-port" class="block text-xs font-medium text-gray-700">포트</label>
						<input
							id="c-port"
							type="number"
							name="port"
							value="389"
							class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
						/>
					</div>
					<div>
						<label for="c-baseDN" class="block text-xs font-medium text-gray-700">Base DN</label>
						<input
							id="c-baseDN"
							type="text"
							name="baseDN"
							placeholder="dc=example,dc=com"
							class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
						/>
					</div>
				</div>

				<!-- 인증 방식 (접이식) -->
				<details class="rounded-lg border border-gray-200 bg-white" open>
					<summary class="cursor-pointer px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50">
						인증 방식 — Admin Bind + Search (ou가 여러 개인 경우) 또는 DN 패턴
					</summary>
					<div class="space-y-3 p-4">
						<p class="text-xs text-gray-500">
							Admin Bind DN을 입력하면 Search 방식을 사용합니다. 비워두면 유저 DN 패턴을 사용합니다.
						</p>
						<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<div>
								<label for="c-bindDN" class="block text-xs font-medium text-gray-700">Admin Bind DN</label>
								<input
									id="c-bindDN"
									type="text"
									name="bindDN"
									placeholder="cn=read-only-admin,dc=example,dc=com"
									class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
								/>
							</div>
							<div>
								<label for="c-bindPw" class="block text-xs font-medium text-gray-700">Admin Bind 패스워드</label>
								<input
									id="c-bindPw"
									type="password"
									name="bindPassword"
									class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
								/>
							</div>
							<div>
								<label for="c-filter" class="block text-xs font-medium text-gray-700">
									유저 검색 필터 <span class="text-gray-400">(기본: (uid=&#123;username&#125;))</span>
								</label>
								<input
									id="c-filter"
									type="text"
									name="userSearchFilter"
									placeholder="(uid={'{'}username{'}'}})"
									class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
								/>
							</div>
							<div>
								<label for="c-pattern2" class="block text-xs font-medium text-gray-700">
									유저 DN 패턴 <span class="text-gray-400">(Admin Bind 미사용 시)</span>
								</label>
								<input
									id="c-pattern2"
									type="text"
									name="userDnPattern"
									placeholder="uid={'{'}username{'}'},dc=example,dc=com"
									class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
								/>
							</div>
						</div>
					</div>
				</details>

				<!-- 속성 매핑 (접이식) -->
				<details class="rounded-lg border border-gray-200 bg-white">
					<summary class="cursor-pointer px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
						>속성 매핑 (기본값: mail, cn, givenName, sn)</summary
					>
					<div class="grid grid-cols-2 gap-3 p-4">
						<div>
							<label for="c-attrEmail" class="block text-xs font-medium text-gray-700"
								>이메일 속성</label
							>
							<input
								id="c-attrEmail"
								type="text"
								name="attrEmail"
								placeholder="mail"
								class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
							/>
						</div>
						<div>
							<label for="c-attrDisplay" class="block text-xs font-medium text-gray-700"
								>표시 이름 속성</label
							>
							<input
								id="c-attrDisplay"
								type="text"
								name="attrDisplayName"
								placeholder="cn"
								class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
							/>
						</div>
						<div>
							<label for="c-attrGiven" class="block text-xs font-medium text-gray-700"
								>이름 속성</label
							>
							<input
								id="c-attrGiven"
								type="text"
								name="attrGivenName"
								placeholder="givenName"
								class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
							/>
						</div>
						<div>
							<label for="c-attrFamily" class="block text-xs font-medium text-gray-700"
								>성 속성</label
							>
							<input
								id="c-attrFamily"
								type="text"
								name="attrFamilyName"
								placeholder="sn"
								class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
							/>
						</div>
					</div>
				</details>

				<div class="flex justify-end">
					<button
						type="submit"
						class="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
						>추가</button
					>
				</div>
			</form>
		</div>
	{/if}

	<!-- 테이블 -->
	<div class="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
		<table class="min-w-full divide-y divide-gray-200">
			<thead class="bg-gray-50">
				<tr>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>이름</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>호스트</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>유저 DN 패턴</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>상태</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>생성</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>작업</th
					>
				</tr>
			</thead>
			<tbody class="divide-y divide-gray-200">
				{#if data.providers.length === 0}
					<tr>
						<td colspan="6" class="px-6 py-8 text-center text-sm text-gray-500">
							등록된 LDAP 프로바이더가 없습니다.
						</td>
					</tr>
				{:else}
					{#each data.providers as provider (provider.id)}
						{@const cfg = parseConfig(provider.configJson)}
						<tr class="hover:bg-gray-50">
							<td class="px-4 py-3">
								<p class="text-sm font-medium text-gray-900">{provider.name}</p>
							</td>
							<td class="px-4 py-3 font-mono text-xs text-gray-600">
								{cfg.host}:{cfg.port}
							</td>
							<td class="max-w-xs truncate px-4 py-3 font-mono text-xs text-gray-500">
								{cfg.userDnPattern}
							</td>
							<td class="px-4 py-3">
								<span
									class="rounded-full px-2 py-0.5 text-xs font-medium {provider.enabled
										? 'bg-green-100 text-green-700'
										: 'bg-gray-100 text-gray-500'}"
								>
									{provider.enabled ? '활성' : '비활성'}
								</span>
							</td>
							<td class="px-4 py-3 text-xs text-gray-400"
								>{dateFormatter.format(provider.createdAt)}</td
							>
							<td class="px-4 py-3">
								<div class="flex items-center gap-2">
									<button
										type="button"
										onclick={() => (editingId = editingId === provider.id ? null : provider.id)}
										class="text-xs text-blue-500 hover:text-blue-700"
									>
										{editingId === provider.id ? '접기' : '편집'}
									</button>
									<form method="POST" action="?/delete" use:enhance>
										<input type="hidden" name="id" value={provider.id} />
										<button
											type="submit"
											class="text-xs text-red-400 hover:text-red-600"
											onclick={(e) => {
												if (!confirm('LDAP 프로바이더를 삭제하시겠습니까?')) e.preventDefault();
											}}
										>
											삭제
										</button>
									</form>
								</div>
							</td>
						</tr>

						<!-- 편집 인라인 폼 -->
						{#if editingId === provider.id}
							{@const c = parseConfig(provider.configJson)}
							<tr class="bg-gray-50">
								<td colspan="6" class="px-4 py-4">
									<form
										method="POST"
										action="?/update"
										use:enhance={() =>
											({ result, update }) => {
												update();
												if (result.type === 'success') editingId = null;
											}}
										class="space-y-4"
									>
										<input type="hidden" name="id" value={provider.id} />
										<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
											<div>
												<label
													for="e-name-{provider.id}"
													class="block text-xs font-medium text-gray-700">이름 *</label
												>
												<input
													id="e-name-{provider.id}"
													type="text"
													name="name"
													value={provider.name}
													required
													class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
												/>
											</div>
											<div>
												<label
													for="e-tls-{provider.id}"
													class="block text-xs font-medium text-gray-700">TLS 모드</label
												>
												<select
													id="e-tls-{provider.id}"
													name="tlsMode"
													class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
												>
													<option value="none" selected={c.tlsMode === 'none'}>없음 (ldap://)</option>
													<option value="tls" selected={c.tlsMode === 'tls'}>TLS (ldaps://)</option>
													<option value="starttls" selected={c.tlsMode === 'starttls'}>STARTTLS</option>
												</select>
											</div>
											<div>
												<label
													for="e-host-{provider.id}"
													class="block text-xs font-medium text-gray-700">호스트 *</label
												>
												<input
													id="e-host-{provider.id}"
													type="text"
													name="host"
													value={c.host}
													required
													class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
												/>
											</div>
											<div>
												<label
													for="e-port-{provider.id}"
													class="block text-xs font-medium text-gray-700">포트</label
												>
												<input
													id="e-port-{provider.id}"
													type="number"
													name="port"
													value={c.port}
													class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
												/>
											</div>
											<div>
												<label
													for="e-base-{provider.id}"
													class="block text-xs font-medium text-gray-700">Base DN</label
												>
												<input
													id="e-base-{provider.id}"
													type="text"
													name="baseDN"
													value={c.baseDN}
													class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
												/>
											</div>
										</div>

										<details class="rounded-lg border border-gray-200 bg-white" open>
											<summary class="cursor-pointer px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50">
												인증 방식
											</summary>
											<div class="space-y-3 p-4">
												<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
													<div>
														<label for="e-bindDN-{provider.id}" class="block text-xs font-medium text-gray-700">Admin Bind DN</label>
														<input
															id="e-bindDN-{provider.id}"
															type="text"
															name="bindDN"
															value={c.bindDN ?? ''}
															placeholder="cn=read-only-admin,dc=example,dc=com"
															class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
														/>
													</div>
													<div>
														<label for="e-bindPw-{provider.id}" class="block text-xs font-medium text-gray-700">Admin Bind 패스워드</label>
														<input
															id="e-bindPw-{provider.id}"
															type="password"
															name="bindPassword"
															value={c.bindPassword ?? ''}
															class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
														/>
													</div>
													<div>
														<label for="e-filter-{provider.id}" class="block text-xs font-medium text-gray-700">
															유저 검색 필터
														</label>
														<input
															id="e-filter-{provider.id}"
															type="text"
															name="userSearchFilter"
															value={c.userSearchFilter ?? ''}
															placeholder="(uid={'{'}username{'}'}})"
															class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
														/>
													</div>
													<div>
														<label for="e-pattern-{provider.id}" class="block text-xs font-medium text-gray-700">
															유저 DN 패턴 <span class="text-gray-400">(Admin Bind 미사용 시)</span>
														</label>
														<input
															id="e-pattern-{provider.id}"
															type="text"
															name="userDnPattern"
															value={c.userDnPattern ?? ''}
															placeholder="uid={'{'}username{'}'},dc=example,dc=com"
															class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
														/>
													</div>
												</div>
											</div>
										</details>

										<details class="rounded-lg border border-gray-200 bg-white">
											<summary
												class="cursor-pointer px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
												>속성 매핑</summary
											>
											<div class="grid grid-cols-2 gap-3 p-4">
												<div>
													<label
														for="e-attrEmail-{provider.id}"
														class="block text-xs font-medium text-gray-700">이메일 속성</label
													>
													<input
														id="e-attrEmail-{provider.id}"
														type="text"
														name="attrEmail"
														value={c.attributeMap?.email ?? ''}
														placeholder="mail"
														class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
													/>
												</div>
												<div>
													<label
														for="e-attrDisplay-{provider.id}"
														class="block text-xs font-medium text-gray-700">표시 이름 속성</label
													>
													<input
														id="e-attrDisplay-{provider.id}"
														type="text"
														name="attrDisplayName"
														value={c.attributeMap?.displayName ?? ''}
														placeholder="cn"
														class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
													/>
												</div>
												<div>
													<label
														for="e-attrGiven-{provider.id}"
														class="block text-xs font-medium text-gray-700">이름 속성</label
													>
													<input
														id="e-attrGiven-{provider.id}"
														type="text"
														name="attrGivenName"
														value={c.attributeMap?.givenName ?? ''}
														placeholder="givenName"
														class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
													/>
												</div>
												<div>
													<label
														for="e-attrFamily-{provider.id}"
														class="block text-xs font-medium text-gray-700">성 속성</label
													>
													<input
														id="e-attrFamily-{provider.id}"
														type="text"
														name="attrFamilyName"
														value={c.attributeMap?.familyName ?? ''}
														placeholder="sn"
														class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
													/>
												</div>
											</div>
										</details>

										<div class="flex items-center justify-between">
											<div class="flex items-center gap-2">
												<input
													id="e-enabled-{provider.id}"
													type="checkbox"
													name="enabled"
													value="true"
													checked={provider.enabled}
													class="h-4 w-4 rounded border-gray-300 text-blue-600"
												/>
												<label for="e-enabled-{provider.id}" class="text-xs text-gray-700">활성화</label>
											</div>
											<div class="flex gap-2">
												<button
													type="button"
													onclick={() => (editingId = null)}
													class="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
													>취소</button
												>
												<button
													type="submit"
													class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
													>저장</button
												>
											</div>
										</div>
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
