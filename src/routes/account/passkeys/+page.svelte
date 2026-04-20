<script lang="ts">
import { enhance } from "$app/forms";
import { invalidateAll } from "$app/navigation";
import type { ActionData, PageData } from "./$types";
import { t } from "$lib/i18n.svelte";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();

let registering = $state(false);
let registerError = $state("");
let registerLabel = $state("");

async function registerPasskey() {
    registerError = "";
    registering = true;
    try {
        const optRes = await fetch("/api/webauthn/register/options", { method: "POST" });
        if (!optRes.ok) {
            const msg = await optRes.text();
            throw new Error(msg || "옵션 요청 실패");
        }
        const options = await optRes.json();

        const { startRegistration } = await import("@simplewebauthn/browser");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const regResponse = await startRegistration({ optionsJSON: options as any });

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
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
            <a href="/" class="text-sm text-gray-500 hover:underline">← {t("mfa_manage.back_to_home")}</a>
        </div>

        <div class="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
            <h1 class="mb-1 text-2xl font-bold text-gray-900">{t("passkeys.title")}</h1>
            <p class="mb-6 text-sm text-gray-500">{t("passkeys.subtitle")}</p>

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
                                    <p class="text-sm font-medium text-gray-900">
                                        {pk.label ?? t("account.passkeys")}
                                    </p>
                                    <p class="text-xs text-gray-400">
                                        {t("passkeys.registered_date")} {new Date(pk.createdAt).toLocaleDateString("ko-KR")}
                                        {#if pk.lastUsedAt}
                                            {t("passkeys.last_used")} {new Date(pk.lastUsedAt).toLocaleDateString("ko-KR")}
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
                                        if (!confirm(t("passkeys.delete_confirm"))) e.preventDefault();
                                    }}>
                                    {t("common.delete")}
                                </button>
                            </form>
                        </div>
                    {/each}
                </div>
            {:else}
                <div class="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <p class="text-sm text-gray-500">{t("passkeys.empty")}</p>
                </div>
            {/if}

            <div class="space-y-3">
                <div>
                    <label for="passkey-label" class="block text-sm font-medium text-gray-700">{t("passkeys.name_label")}</label>
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
                        {t("passkeys.registering")}
                    {:else}
                        {t("passkeys.register")}
                    {/if}
                </button>
            </div>
        </div>
    </div>
</div>
