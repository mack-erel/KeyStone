<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	const { data, form } = $props<{ data: PageData; form?: ActionData }>();

	const dateFormatter = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' });

	let showCreate = $state(false);
	let editingId = $state<string | null>(null);

	// 생성 폼 필드 상태 (메타데이터 파싱 결과로 채워짐)
	let createName = $state('');
	let createEntityId = $state('');
	let createAcsUrl = $state('');
	let createSloUrl = $state('');
	let createNameIdFormat = $state('urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress');
	let createCert = $state('');
	let createSignAssertion = $state(true);
	let createSignResponse = $state(false);
	let createWantSigned = $state(false);
	let createAllowedAttributes = $state('');

	// 메타데이터 파싱
	let metadataXml = $state('');
	let metaParseError = $state<string | null>(null);

	function parseSpMetadata() {
		metaParseError = null;
		const xml = metadataXml.trim();
		if (!xml) return;

		try {
			const parser = new DOMParser();
			const doc = parser.parseFromString(xml, 'text/xml');

			const parseErr = doc.querySelector('parsererror');
			if (parseErr) throw new Error('XML 파싱 오류');

			// entityID
			const entityId = doc.documentElement.getAttribute('entityID') ?? '';
			if (entityId) createEntityId = entityId;

			// ACS URL — HTTP-POST 우선, 없으면 첫 번째
			const acsList = doc.querySelectorAll('AssertionConsumerService');
			let acsUrl = '';
			for (const acs of acsList) {
				if ((acs.getAttribute('Binding') ?? '').includes('HTTP-POST')) {
					acsUrl = acs.getAttribute('Location') ?? '';
					break;
				}
			}
			if (!acsUrl && acsList.length > 0) acsUrl = acsList[0].getAttribute('Location') ?? '';
			if (acsUrl) createAcsUrl = acsUrl;

			// SLO URL
			const slo = doc.querySelector('SingleLogoutService');
			if (slo) createSloUrl = slo.getAttribute('Location') ?? '';

			// NameID Format (첫 번째)
			const nameIdEl = doc.querySelector('NameIDFormat');
			if (nameIdEl?.textContent) createNameIdFormat = nameIdEl.textContent.trim();

			// 서명용 인증서
			const certEl =
				doc.querySelector("KeyDescriptor[use='signing'] X509Certificate") ??
				doc.querySelector('X509Certificate');
			if (certEl?.textContent) {
				const raw = certEl.textContent.trim().replace(/\s/g, '');
				const lines = raw.match(/.{1,64}/g)?.join('\n') ?? raw;
				createCert = `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`;
			}

			// 이름 자동 제안 (entityID 도메인)
			if (!createName && entityId) {
				try {
					createName = new URL(entityId).hostname;
				} catch {
					createName = entityId;
				}
			}
		} catch (e) {
			metaParseError = e instanceof Error ? e.message : '파싱 실패';
		}
	}

	function resetCreateForm() {
		createName = '';
		createEntityId = '';
		createAcsUrl = '';
		createSloUrl = '';
		createNameIdFormat = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
		createCert = '';
		createSignAssertion = true;
		createSignResponse = false;
		createWantSigned = false;
		createAllowedAttributes = '';
		metadataXml = '';
		metaParseError = null;
	}

	const createErr = $derived(
		(form as { create?: boolean; error?: string } | null)?.create
			? ((form as { error?: string } | null)?.error ?? null)
			: null
	);
	const globalErr = $derived(
		createErr ? null : ((form as { error?: string } | null)?.error ?? null)
	);

	function formatAllowedAttributes(raw: string | null): string {
		if (!raw) return '';
		try {
			const parsed = JSON.parse(raw) as unknown;
			return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string').join(',') : '';
		} catch {
			return '';
		}
	}

	const NAME_ID_OPTIONS = [
		{ value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', label: 'emailAddress' },
		{ value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', label: 'persistent' },
		{ value: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient', label: 'transient' },
		{ value: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified', label: 'unspecified' }
	];
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<h1 class="text-2xl font-bold text-gray-900">SAML SP 관리</h1>
		<button
			type="button"
			onclick={() => {
				showCreate = !showCreate;
				editingId = null;
				if (!showCreate) resetCreateForm();
			}}
			class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
		>
			{showCreate ? '취소' : '+ SP 추가'}
		</button>
	</div>

	{#if globalErr}
		<div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
			{globalErr}
		</div>
	{/if}

	<!-- 생성 폼 -->
	{#if showCreate}
		<div class="space-y-4 rounded-xl border border-blue-100 bg-blue-50 p-5">
			<h2 class="font-semibold text-blue-900">새 SAML SP 등록</h2>

			<!-- 메타데이터 붙여넣기 -->
			<div class="space-y-2 rounded-lg border border-blue-200 bg-white p-4">
				<p class="text-xs font-medium text-gray-700">
					SP 메타데이터 XML로 자동 입력 <span class="font-normal text-gray-400">(선택)</span>
				</p>
				{#if metaParseError}
					<div class="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-600">
						{metaParseError}
					</div>
				{/if}
				<textarea
					bind:value={metadataXml}
					rows="4"
					placeholder="<md:EntityDescriptor ...> 를 붙여넣으세요"
					class="block w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-xs focus:border-blue-500 focus:outline-none"
				></textarea>
				<button
					type="button"
					onclick={parseSpMetadata}
					class="rounded-md bg-gray-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800"
				>
					메타데이터 파싱 →
				</button>
			</div>

			{#if createErr}
				<div class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
					{createErr}
				</div>
			{/if}

			<form
				method="POST"
				action="?/create"
				use:enhance={() =>
					({ result, update }) => {
						update();
						if (result.type === 'success') {
							showCreate = false;
							resetCreateForm();
						}
					}}
				class="grid grid-cols-1 gap-3 sm:grid-cols-2"
			>
				<div>
					<label for="s-name" class="block text-xs font-medium text-gray-700">이름 *</label>
					<input
						id="s-name"
						type="text"
						name="name"
						required
						bind:value={createName}
						class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
					/>
				</div>
				<div>
					<label for="s-entityId" class="block text-xs font-medium text-gray-700">Entity ID *</label
					>
					<input
						id="s-entityId"
						type="text"
						name="entityId"
						required
						bind:value={createEntityId}
						class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-sm focus:border-blue-500 focus:outline-none"
					/>
				</div>
				<div class="sm:col-span-2">
					<label for="s-acsUrl" class="block text-xs font-medium text-gray-700">ACS URL *</label>
					<input
						id="s-acsUrl"
						type="url"
						name="acsUrl"
						required
						bind:value={createAcsUrl}
						class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
					/>
				</div>
				<div class="sm:col-span-2">
					<label for="s-sloUrl" class="block text-xs font-medium text-gray-700">SLO URL</label>
					<input
						id="s-sloUrl"
						type="url"
						name="sloUrl"
						bind:value={createSloUrl}
						class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
					/>
				</div>
				<div>
					<label for="s-nameIdFormat" class="block text-xs font-medium text-gray-700"
						>NameID Format</label
					>
					<select
						id="s-nameIdFormat"
						name="nameIdFormat"
						bind:value={createNameIdFormat}
						class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
					>
						{#each NAME_ID_OPTIONS as opt}
							<option value={opt.value}>{opt.label}</option>
						{/each}
					</select>
				</div>
				<div class="flex flex-col gap-2 pt-4">
					<div class="flex items-center gap-2">
						<input
							id="s-signAssertion"
							type="checkbox"
							name="signAssertion"
							value="true"
							bind:checked={createSignAssertion}
							class="h-4 w-4 rounded border-gray-300"
						/>
						<label for="s-signAssertion" class="text-xs text-gray-700">Assertion 서명</label>
					</div>
					<div class="flex items-center gap-2">
						<input
							id="s-signResponse"
							type="checkbox"
							name="signResponse"
							value="true"
							bind:checked={createSignResponse}
							class="h-4 w-4 rounded border-gray-300"
						/>
						<label for="s-signResponse" class="text-xs text-gray-700">Response 서명</label>
					</div>
					<div class="flex items-center gap-2">
						<input
							id="s-wantSigned"
							type="checkbox"
							name="wantAuthnRequestsSigned"
							value="true"
							bind:checked={createWantSigned}
							class="h-4 w-4 rounded border-gray-300"
						/>
						<label for="s-wantSigned" class="text-xs text-gray-700">AuthnRequest 서명 요구</label>
					</div>
				</div>
				<div class="sm:col-span-2">
					<label for="s-cert" class="block text-xs font-medium text-gray-700"
						>SP 인증서 (PEM, 선택)</label
					>
					<textarea
						id="s-cert"
						name="cert"
						rows="4"
						bind:value={createCert}
						placeholder="-----BEGIN CERTIFICATE-----"
						class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-xs focus:border-blue-500 focus:outline-none"
					></textarea>
				</div>
				<div class="sm:col-span-2">
					<label for="s-allowedAttributes" class="block text-xs font-medium text-gray-700">
						허용 속성 (콤마 구분, 비우면 email,username,displayName 만 전송)
					</label>
					<input
						id="s-allowedAttributes"
						type="text"
						name="allowedAttributes"
						bind:value={createAllowedAttributes}
						placeholder="email,username,displayName,department,team,jobTitle,position,givenName,familyName,surName,phoneNumber"
						class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-xs focus:border-blue-500 focus:outline-none"
					/>
				</div>
				<div class="flex justify-end sm:col-span-2">
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
						>이름 / Entity ID</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>ACS URL</th
					>
					<th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase"
						>서명</th
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
				{#if data.sps.length === 0}
					<tr>
						<td colspan="6" class="px-6 py-8 text-center text-sm text-gray-500"
							>등록된 SAML SP 가 없습니다.</td
						>
					</tr>
				{:else}
					{#each data.sps as sp (sp.id)}
						<tr class="hover:bg-gray-50">
							<td class="px-4 py-3">
								<p class="text-sm font-medium text-gray-900">{sp.name}</p>
								<p class="font-mono text-xs break-all text-gray-400">{sp.entityId}</p>
							</td>
							<td class="max-w-[200px] px-4 py-3 text-xs break-all text-gray-500">{sp.acsUrl}</td>
							<td class="px-4 py-3 text-xs text-gray-500">
								{#if sp.signAssertion}<span
										class="mr-1 rounded bg-blue-50 px-1 py-0.5 text-blue-600">Assertion</span
									>{/if}
								{#if sp.signResponse}<span class="rounded bg-purple-50 px-1 py-0.5 text-purple-600"
										>Response</span
									>{/if}
							</td>
							<td class="px-4 py-3">
								<span
									class="rounded-full px-2 py-0.5 text-xs font-medium {sp.enabled
										? 'bg-green-100 text-green-700'
										: 'bg-gray-100 text-gray-500'}"
								>
									{sp.enabled ? '활성' : '비활성'}
								</span>
							</td>
							<td class="px-4 py-3 text-xs text-gray-400">{dateFormatter.format(sp.createdAt)}</td>
							<td class="px-4 py-3">
								<div class="flex items-center gap-2">
									<button
										type="button"
										onclick={() => (editingId = editingId === sp.id ? null : sp.id)}
										class="text-xs text-blue-500 hover:text-blue-700"
									>
										{editingId === sp.id ? '접기' : '편집'}
									</button>
									<form method="POST" action="?/delete" use:enhance>
										<input type="hidden" name="id" value={sp.id} />
										<button
											type="submit"
											class="text-xs text-red-400 hover:text-red-600"
											onclick={(e) => {
												if (!confirm('SP를 삭제하시겠습니까?')) e.preventDefault();
											}}
										>
											삭제
										</button>
									</form>
								</div>
							</td>
						</tr>

						<!-- 편집 인라인 폼 -->
						{#if editingId === sp.id}
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
										class="grid grid-cols-1 gap-3 sm:grid-cols-2"
									>
										<input type="hidden" name="id" value={sp.id} />
										<div>
											<label for="e-name-{sp.id}" class="block text-xs font-medium text-gray-700"
												>이름 *</label
											>
											<input
												id="e-name-{sp.id}"
												type="text"
												name="name"
												value={sp.name}
												required
												class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
											/>
										</div>
										<div>
											<label
												for="e-nameIdFormat-{sp.id}"
												class="block text-xs font-medium text-gray-700">NameID Format</label
											>
											<select
												id="e-nameIdFormat-{sp.id}"
												name="nameIdFormat"
												class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
											>
												{#each NAME_ID_OPTIONS as opt}
													<option value={opt.value} selected={sp.nameIdFormat === opt.value}
														>{opt.label}</option
													>
												{/each}
											</select>
										</div>
										<div class="sm:col-span-2">
											<label for="e-acsUrl-{sp.id}" class="block text-xs font-medium text-gray-700"
												>ACS URL *</label
											>
											<input
												id="e-acsUrl-{sp.id}"
												type="url"
												name="acsUrl"
												value={sp.acsUrl}
												required
												class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
											/>
										</div>
										<div class="sm:col-span-2">
											<label for="e-sloUrl-{sp.id}" class="block text-xs font-medium text-gray-700"
												>SLO URL</label
											>
											<input
												id="e-sloUrl-{sp.id}"
												type="url"
												name="sloUrl"
												value={sp.sloUrl ?? ''}
												class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
											/>
										</div>
										<div class="flex flex-col gap-2">
											<div class="flex items-center gap-2">
												<input
													id="e-signAssertion-{sp.id}"
													type="checkbox"
													name="signAssertion"
													value="true"
													checked={sp.signAssertion}
													class="h-4 w-4 rounded border-gray-300"
												/>
												<label for="e-signAssertion-{sp.id}" class="text-xs text-gray-700"
													>Assertion 서명</label
												>
											</div>
											<div class="flex items-center gap-2">
												<input
													id="e-signResponse-{sp.id}"
													type="checkbox"
													name="signResponse"
													value="true"
													checked={sp.signResponse}
													class="h-4 w-4 rounded border-gray-300"
												/>
												<label for="e-signResponse-{sp.id}" class="text-xs text-gray-700"
													>Response 서명</label
												>
											</div>
											<div class="flex items-center gap-2">
												<input
													id="e-wantSigned-{sp.id}"
													type="checkbox"
													name="wantAuthnRequestsSigned"
													value="true"
													checked={sp.wantAuthnRequestsSigned}
													class="h-4 w-4 rounded border-gray-300"
												/>
												<label for="e-wantSigned-{sp.id}" class="text-xs text-gray-700"
													>AuthnRequest 서명 요구</label
												>
											</div>
											<div class="flex items-center gap-2">
												<input
													id="e-enabled-{sp.id}"
													type="checkbox"
													name="enabled"
													value="true"
													checked={sp.enabled}
													class="h-4 w-4 rounded border-gray-300"
												/>
												<label for="e-enabled-{sp.id}" class="text-xs text-gray-700">활성</label>
											</div>
										</div>
										<div class="sm:col-span-2">
											<label for="e-cert-{sp.id}" class="block text-xs font-medium text-gray-700"
												>SP 인증서 (PEM)</label
											>
											<textarea
												id="e-cert-{sp.id}"
												name="cert"
												rows="4"
												class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-xs focus:border-blue-500 focus:outline-none"
												>{sp.cert ?? ''}</textarea
											>
										</div>
										<div class="sm:col-span-2">
											<label
												for="e-allowedAttributes-{sp.id}"
												class="block text-xs font-medium text-gray-700"
											>
												허용 속성 (콤마 구분, 비우면 email,username,displayName 만 전송)
											</label>
											<input
												id="e-allowedAttributes-{sp.id}"
												type="text"
												name="allowedAttributes"
												value={formatAllowedAttributes(sp.allowedAttributes)}
												placeholder="email,username,displayName"
												class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 font-mono text-xs focus:border-blue-500 focus:outline-none"
											/>
										</div>
										<div class="flex justify-end gap-2 sm:col-span-2">
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
