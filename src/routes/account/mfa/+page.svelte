<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import type { ActionData, PageData } from './$types';

	const { data, form } = $props<{ data: PageData; form?: ActionData }>();

	let qrDataUrl = $state('');
	let qrError = $state(false);

	// QR 코드 렌더링 (클라이언트 전용)
	const otpauthUri = $derived(
		(form as { otpauthUri?: string } | null)?.otpauthUri ?? data.pendingUri ?? null
	);

	onMount(async () => {
		if (otpauthUri) {
			try {
				const QRCode = (await import('qrcode')).default;
				qrDataUrl = await QRCode.toDataURL(otpauthUri, { width: 200, margin: 2 });
			} catch {
				qrError = true;
			}
		}
	});

	$effect(() => {
		if (otpauthUri) {
			(async () => {
				try {
					const QRCode = (await import('qrcode')).default;
					qrDataUrl = await QRCode.toDataURL(otpauthUri, { width: 200, margin: 2 });
					qrError = false;
				} catch {
					qrError = true;
				}
			})();
		} else {
			qrDataUrl = '';
		}
	});

	const backupCodes = $derived((form as { backupCodes?: string[] } | null)?.backupCodes ?? null);

	const formError = $derived((form as { error?: string } | null)?.error ?? null);

	const isSetupMode = $derived(!!otpauthUri);
	const isConfirmMode = $derived(
		(form as { confirm?: boolean } | null)?.confirm === true && !backupCodes
	);
</script>

<div class="min-h-screen bg-gray-50 p-4">
	<div class="mx-auto max-w-lg">
		<div class="mb-6">
			<a href="/" class="text-sm text-gray-500 hover:underline">← 홈으로</a>
		</div>

		<div class="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
			<h1 class="mb-6 text-2xl font-bold text-gray-900">2단계 인증 관리</h1>

			<!-- 에러 -->
			{#if formError}
				<div class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
					{formError}
				</div>
			{/if}

			<!-- 백업 코드 표시 (등록 직후 또는 재생성 직후) -->
			{#if backupCodes}
				<div class="mb-6 rounded-xl border border-green-200 bg-green-50 p-5">
					<h2 class="mb-2 font-semibold text-green-900">백업 코드가 생성되었습니다</h2>
					<p class="mb-4 text-sm text-green-700">
						이 코드는 지금만 표시됩니다. 안전한 곳에 저장해 두세요. 코드 하나당 1회만 사용
						가능합니다.
					</p>
					<div class="grid grid-cols-2 gap-2">
						{#each backupCodes as code}
							<code
								class="rounded-md bg-white px-3 py-1.5 text-center font-mono text-sm text-gray-800 shadow-sm"
							>
								{code}
							</code>
						{/each}
					</div>
				</div>
			{/if}

			<!-- QR 코드 / 등록 화면 -->
			{#if isSetupMode}
				<div class="space-y-5">
					<div class="rounded-xl border border-blue-100 bg-blue-50 p-4">
						<h2 class="mb-2 font-semibold text-blue-900">인증 앱 등록</h2>
						<p class="text-sm text-blue-700">
							Google Authenticator, Authy 등 TOTP 앱으로 QR 코드를 스캔하세요.
						</p>
					</div>

					<div class="flex flex-col items-center gap-3">
						{#if qrDataUrl}
							<img src={qrDataUrl} alt="TOTP QR 코드" class="rounded-lg border border-gray-200" />
						{:else if qrError}
							<p class="text-sm text-gray-500">QR 코드 생성 실패</p>
						{:else}
							<div
								class="flex h-[200px] w-[200px] items-center justify-center rounded-lg border border-gray-200 bg-gray-50"
							>
								<span class="text-xs text-gray-400">로딩 중...</span>
							</div>
						{/if}

						<details class="w-full">
							<summary class="cursor-pointer text-xs text-gray-500 hover:text-gray-700">
								직접 입력 (키 보기)
							</summary>
							<div
								class="mt-2 rounded-md bg-gray-100 px-3 py-2 font-mono text-xs break-all text-gray-600"
							>
								{otpauthUri}
							</div>
						</details>
					</div>

					<form method="POST" action="?/confirm" use:enhance class="space-y-3">
						<div>
							<label for="code" class="block text-sm font-medium text-gray-700">
								앱에 표시된 6자리 코드 입력
							</label>
							<input
								type="text"
								name="code"
								id="code"
								required
								inputmode="numeric"
								maxlength={6}
								placeholder="000000"
								class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-center text-lg tracking-widest shadow-sm focus:border-blue-500 focus:outline-none"
							/>
						</div>
						<button
							type="submit"
							class="flex w-full justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700"
						>
							등록 완료
						</button>
					</form>

					<form method="POST" action="?/setup" use:enhance>
						<button type="submit" class="w-full text-center text-sm text-gray-500 hover:underline">
							새 QR 코드 생성
						</button>
					</form>
				</div>

				<!-- 등록된 상태 -->
			{:else if data.enrolled}
				<div class="space-y-5">
					<div class="flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-4">
						<svg class="h-5 w-5 shrink-0 text-green-600" fill="currentColor" viewBox="0 0 20 20">
							<path
								fill-rule="evenodd"
								d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
								clip-rule="evenodd"
							/>
						</svg>
						<div>
							<p class="font-medium text-green-900">TOTP 인증기가 등록되어 있습니다.</p>
							{#if data.enrolledAt}
								<p class="text-xs text-green-700">
									등록일: {new Date(data.enrolledAt).toLocaleDateString('ko-KR')}
								</p>
							{/if}
						</div>
					</div>

					<!-- 백업 코드 상태 -->
					<div class="rounded-xl border border-gray-200 p-4">
						<div class="flex items-center justify-between">
							<div>
								<p class="font-medium text-gray-900">백업 코드</p>
								<p class="text-sm text-gray-500">
									{data.backupCodesRemaining}개 남음
									{#if data.backupCodesRemaining === 0}
										<span class="text-red-500"> — 재생성이 필요합니다</span>
									{:else if data.backupCodesRemaining <= 3}
										<span class="text-amber-500"> — 코드가 부족합니다</span>
									{/if}
								</p>
							</div>
							<form method="POST" action="?/regenerate" use:enhance class="flex items-center gap-2">
								<input
									type="text"
									name="code"
									required
									inputmode="numeric"
									maxlength={6}
									placeholder="TOTP 코드"
									class="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-center font-mono text-sm tracking-widest focus:border-blue-500 focus:outline-none"
								/>
								<button
									type="submit"
									class="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50"
									onclick={(e) => {
										if (
											!confirm('기존 백업 코드가 모두 삭제되고 새로 발급됩니다. 계속하시겠습니까?')
										) {
											e.preventDefault();
										}
									}}
								>
									재생성
								</button>
							</form>
						</div>
					</div>

					<!-- TOTP 삭제 -->
					<form method="POST" action="?/delete" use:enhance class="space-y-2">
						<input
							type="text"
							name="code"
							required
							inputmode="numeric"
							maxlength={6}
							placeholder="현재 TOTP 코드 입력 후 삭제"
							class="block w-full rounded-md border border-red-200 px-3 py-2 text-center font-mono text-sm tracking-widest focus:border-red-400 focus:outline-none"
						/>
						<button
							type="submit"
							class="flex w-full justify-center rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50"
							onclick={(e) => {
								if (!confirm('TOTP 인증기와 모든 백업 코드가 삭제됩니다. 계속하시겠습니까?')) {
									e.preventDefault();
								}
							}}
						>
							인증기 삭제
						</button>
					</form>
				</div>

				<!-- 미등록 상태 -->
			{:else}
				<div class="space-y-5">
					<div class="rounded-xl border border-gray-200 bg-gray-50 p-4">
						<p class="text-sm text-gray-600">
							2단계 인증을 활성화하면 계정 보안이 강화됩니다. Google Authenticator, Authy 등의 인증
							앱이 필요합니다.
						</p>
					</div>

					<form method="POST" action="?/setup" use:enhance>
						<button
							type="submit"
							class="flex w-full justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700"
						>
							인증기 등록 시작
						</button>
					</form>
				</div>
			{/if}
		</div>
	</div>
</div>
