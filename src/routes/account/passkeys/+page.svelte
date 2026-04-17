<script lang="ts">
import { enhance } from "$app/forms";
import { invalidateAll } from "$app/navigation";
import type { ActionData, PageData } from "./$types";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();

let registering = $state(false);
let registerError = $state("");
let registerLabel = $state("");

async function registerPasskey() {
    registerError = "";
    registering = true;
    try {
        // 1. 등록 옵션 요청
        const optRes = await fetch("/api/webauthn/register/options", { method: "POST" });
        if (!optRes.ok) {
            const msg = await optRes.text();
            throw new Error(msg || "옵션 요청 실패");
        }
        const options = await optRes.json();

        // 2. 브라우저 패스키 등록 (클라이언트 전용)
        const { startRegistration } = await import("@simplewebauthn/browser");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const regResponse = await startRegistration({ optionsJSON: options as any });

        // 3. 검증 요청
        const verRes = await fetch("/api/webauthn/register/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...regResponse, label: registerLabel }),
        });

        if (!verRes.ok) {
            const msg = await verRes.text();
            throw new Error(msg || "등록 검증 실패");
        }

        registerLabel = "";
        await invalidateAll();
    } catch (err: unknown) {
        const e = err as { name?: string; message?: string };
        if (e?.name === "NotAllowedError") {
            registerError = "패스키 등록이 취소되었습니다.";
        } else {
            registerError = e?.message ?? "패스키 등록에 실패했습니다.";
        }
    } finally {
        registering = false;
    }
}

const formError = $derived((form as { error?: string } | null)?.error ?? null);
</script>

<div class="min-h-screen bg-gray-50 p-4">
    <div class="mx-auto max-w-lg">
        <div class="mb-6">
            <a href="/" class="text-sm text-gray-500 hover:underline">← 홈으로</a>
        </div>

        <div class="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
            <h1 class="mb-1 text-2xl font-bold text-gray-900">패스키 관리</h1>
            <p class="mb-6 text-sm text-gray-500">지문, Face ID, 보안 키 등으로 비밀번호 없이 로그인할 수 있습니다.</p>

            <!-- 에러 -->
            {#if formError}
                <div class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {formError}
                </div>
            {/if}

            {#if registerError}
                <div class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {registerError}
                </div>
            {/if}

            <!-- 등록된 패스키 목록 -->
            {#if data.passkeys.length > 0}
                <div class="mb-6 space-y-2">
                    {#each data.passkeys as pk (pk.id)}
                        <div class="flex items-center justify-between rounded-xl border border-gray-200 px-4 py-3">
                            <div class="flex items-center gap-3">
                                <svg class="h-5 w-5 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2"
                                        d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                                </svg>
                                <div>
                                    <p class="text-sm font-medium text-gray-900">{pk.label ?? "패스키"}</p>
                                    <p class="text-xs text-gray-400">
                                        등록: {new Date(pk.createdAt).toLocaleDateString("ko-KR")}
                                        {#if pk.lastUsedAt}
                                            · 마지막 사용: {new Date(pk.lastUsedAt).toLocaleDateString("ko-KR")}
                                        {/if}
                                    </p>
                                </div>
                            </div>

                            <form method="POST" action="?/delete" use:enhance>
                                <input type="hidden" name="id" value={pk.id} />
                                <button
                                    type="submit"
                                    class="text-sm text-red-500 hover:text-red-700"
                                    onclick={(e) => {
                                        if (!confirm("이 패스키를 삭제하시겠습니까?")) e.preventDefault();
                                    }}>
                                    삭제
                                </button>
                            </form>
                        </div>
                    {/each}
                </div>
            {:else}
                <div class="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <p class="text-sm text-gray-500">등록된 패스키가 없습니다.</p>
                </div>
            {/if}

            <!-- 새 패스키 등록 -->
            <div class="space-y-3">
                <div>
                    <label for="passkey-label" class="block text-sm font-medium text-gray-700"> 패스키 이름 (선택) </label>
                    <input
                        type="text"
                        id="passkey-label"
                        bind:value={registerLabel}
                        placeholder="예: 맥북 TouchID"
                        maxlength="64"
                        class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none" />
                </div>

                <button
                    type="button"
                    onclick={registerPasskey}
                    disabled={registering}
                    class="flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-60">
                    {#if registering}
                        <svg class="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                        </svg>
                        등록 중...
                    {:else}
                        패스키 등록
                    {/if}
                </button>
            </div>
        </div>
    </div>
</div>
