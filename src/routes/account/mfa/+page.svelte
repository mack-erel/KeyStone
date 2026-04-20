<script lang="ts">
import { enhance } from "$app/forms";
import { onMount } from "svelte";
import type { ActionData, PageData } from "./$types";
import { t } from "$lib/i18n.svelte";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();

let qrDataUrl = $state("");
let qrError = $state(false);

const otpauthUri = $derived((form as { otpauthUri?: string } | null)?.otpauthUri ?? data.pendingUri ?? null);

onMount(async () => {
    if (otpauthUri) {
        try {
            const QRCode = (await import("qrcode")).default;
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
                const QRCode = (await import("qrcode")).default;
                qrDataUrl = await QRCode.toDataURL(otpauthUri, { width: 200, margin: 2 });
                qrError = false;
            } catch {
                qrError = true;
            }
        })();
    } else {
        qrDataUrl = "";
    }
});

const backupCodes = $derived((form as { backupCodes?: string[] } | null)?.backupCodes ?? null);
const formError = $derived((form as { error?: string } | null)?.error ?? null);
const isSetupMode = $derived(!!otpauthUri);
</script>

<div class="min-h-screen bg-gray-50 p-4">
    <div class="mx-auto max-w-lg">
        <div class="mb-6">
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
            <a href="/" class="text-sm text-gray-500 hover:underline">{t("mfa_manage.back_to_home")}</a>
        </div>

        <div class="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
            <h1 class="mb-6 text-2xl font-bold text-gray-900">{t("mfa_manage.title")}</h1>

            {#if formError}
                <div class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {formError}
                </div>
            {/if}

            {#if backupCodes}
                <div class="mb-6 rounded-xl border border-green-200 bg-green-50 p-5">
                    <h2 class="mb-2 font-semibold text-green-900">{t("mfa_manage.backup_codes_generated")}</h2>
                    <p class="mb-4 text-sm text-green-700">{t("mfa_manage.backup_codes_warning")}</p>
                    <div class="grid grid-cols-2 gap-2">
                        {#each backupCodes as code (code)}
                            <code class="rounded-md bg-white px-3 py-1.5 text-center font-mono text-sm text-gray-800 shadow-sm">
                                {code}
                            </code>
                        {/each}
                    </div>
                </div>
            {/if}

            {#if isSetupMode}
                <div class="space-y-5">
                    <div class="rounded-xl border border-blue-100 bg-blue-50 p-4">
                        <h2 class="mb-2 font-semibold text-blue-900">{t("mfa_manage.setup_title")}</h2>
                        <p class="text-sm text-blue-700">{t("mfa_manage.setup_hint")}</p>
                    </div>

                    <div class="flex flex-col items-center gap-3">
                        {#if qrDataUrl}
                            <img src={qrDataUrl} alt="TOTP QR 코드" class="rounded-lg border border-gray-200" />
                        {:else if qrError}
                            <p class="text-sm text-gray-500">{t("mfa_manage.qr_error")}</p>
                        {:else}
                            <div class="flex h-50 w-50 items-center justify-center rounded-lg border border-gray-200 bg-gray-50">
                                <span class="text-xs text-gray-400">{t("mfa_manage.qr_loading")}</span>
                            </div>
                        {/if}

                        <details class="w-full">
                            <summary class="cursor-pointer text-xs text-gray-500 hover:text-gray-700">{t("mfa_manage.manual_entry")}</summary>
                            <div class="mt-2 rounded-md bg-gray-100 px-3 py-2 font-mono text-xs break-all text-gray-600">
                                {otpauthUri}
                            </div>
                        </details>
                    </div>

                    <form method="POST" action="?/confirm" use:enhance class="space-y-3">
                        <div>
                            <label for="code" class="block text-sm font-medium text-gray-700">{t("mfa_manage.code_input_label")}</label>
                            <input
                                type="text"
                                name="code"
                                id="code"
                                required
                                inputmode="numeric"
                                maxlength={6}
                                placeholder="000000"
                                class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-center text-lg tracking-widest shadow-sm focus:border-blue-500 focus:outline-none" />
                        </div>
                        <button type="submit" class="flex w-full justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700">
                            {t("mfa_manage.register_complete")}
                        </button>
                    </form>

                    <form method="POST" action="?/setup" use:enhance>
                        <button type="submit" class="w-full text-center text-sm text-gray-500 hover:underline">{t("mfa_manage.new_qr")}</button>
                    </form>
                </div>
            {:else if data.enrolled}
                <div class="space-y-5">
                    <div class="flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-4">
                        <svg class="h-5 w-5 shrink-0 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                            <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                        </svg>
                        <div>
                            <p class="font-medium text-green-900">{t("mfa_manage.enrolled_badge")}</p>
                            {#if data.enrolledAt}
                                <p class="text-xs text-green-700">
                                    {t("mfa_manage.enrolled_date")}
                                    {new Date(data.enrolledAt).toLocaleDateString("ko-KR")}
                                </p>
                            {/if}
                        </div>
                    </div>

                    <div class="rounded-xl border border-gray-200 p-4">
                        <div class="flex items-center justify-between">
                            <div>
                                <p class="font-medium text-gray-900">{t("mfa_manage.backup_codes_label")}</p>
                                <p class="text-sm text-gray-500">
                                    {t("mfa_manage.backup_codes_remaining", { count: data.backupCodesRemaining })}
                                    {#if data.backupCodesRemaining === 0}
                                        <span class="text-red-500">{t("mfa_manage.backup_codes_empty")}</span>
                                    {:else if data.backupCodesRemaining <= 3}
                                        <span class="text-amber-500">{t("mfa_manage.backup_codes_low")}</span>
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
                                    placeholder={t("mfa_manage.totp_placeholder")}
                                    class="w-28 rounded-md border border-gray-300 px-2 py-1.5 text-center font-mono text-sm tracking-widest focus:border-blue-500 focus:outline-none" />
                                <button
                                    type="submit"
                                    class="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50"
                                    onclick={(e) => {
                                        if (!confirm(t("mfa_manage.regenerate_confirm"))) {
                                            e.preventDefault();
                                        }
                                    }}>
                                    {t("mfa_manage.regenerate")}
                                </button>
                            </form>
                        </div>
                    </div>

                    <form method="POST" action="?/delete" use:enhance class="space-y-2">
                        <input
                            type="text"
                            name="code"
                            required
                            inputmode="numeric"
                            maxlength={6}
                            placeholder={t("mfa_manage.delete_input_placeholder")}
                            class="block w-full rounded-md border border-red-200 px-3 py-2 text-center font-mono text-sm tracking-widest focus:border-red-400 focus:outline-none" />
                        <button
                            type="submit"
                            class="flex w-full justify-center rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50"
                            onclick={(e) => {
                                if (!confirm(t("mfa_manage.delete_confirm"))) {
                                    e.preventDefault();
                                }
                            }}>
                            {t("mfa_manage.delete_button")}
                        </button>
                    </form>
                </div>
            {:else}
                <div class="space-y-5">
                    <div class="rounded-xl border border-gray-200 bg-gray-50 p-4">
                        <p class="text-sm text-gray-600">{t("mfa_manage.not_enrolled_hint")}</p>
                    </div>

                    <form method="POST" action="?/setup" use:enhance>
                        <button type="submit" class="flex w-full justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700">
                            {t("mfa_manage.start_setup")}
                        </button>
                    </form>
                </div>
            {/if}
        </div>
    </div>
</div>
