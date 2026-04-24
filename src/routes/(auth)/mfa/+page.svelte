<script lang="ts">
import type { ActionData, PageData } from "./$types";
import { onMount } from "svelte";
import { t } from "$lib/i18n.svelte";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();

let useBackup = $state(false);

const skinHtmlEffective = $derived((form as { skinHtml?: string | null } | null)?.skinHtml ?? data.skinHtml);

onMount(() => {
    if (!skinHtmlEffective) return;
    const s = document.createElement("script");
    s.src = "/api/skin-scripts";
    document.head.appendChild(s);
    return () => {
        if (s.parentNode) s.parentNode.removeChild(s);
    };
});

const loginHref = $derived(
    (() => {
        const parts: string[] = [];
        if (data.redirectTo) parts.push(`redirectTo=${encodeURIComponent(data.redirectTo)}`);
        if (data.skinHint) parts.push(`skinHint=${encodeURIComponent(data.skinHint)}`);
        return "/login" + (parts.length ? `?${parts.join("&")}` : "");
    })(),
);
</script>

{#if skinHtmlEffective}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html skinHtmlEffective}
{:else}
    <div class="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <div class="w-full max-w-105 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
            <div class="mb-6 space-y-2 text-center">
                <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50">
                    <svg class="h-6 w-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                </div>
                <h1 class="text-2xl font-bold text-gray-900">{t("mfa_login.title")}</h1>
                <p class="text-sm text-gray-500">
                    {#if useBackup}
                        {t("mfa_login.backup_code_hint")}
                    {:else}
                        {t("mfa_login.totp_hint")}
                    {/if}
                </p>
            </div>

            {#if form?.error}
                <div class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {form.error}
                </div>
            {/if}

            <form method="POST" class="space-y-4">
                <input type="hidden" name="use_backup" value={useBackup ? "1" : "0"} />

                <div>
                    <label for="code" class="block text-sm font-medium text-gray-700">
                        {useBackup ? t("mfa_login.backup_code_label") : t("mfa_login.totp_code_label")}
                    </label>
                    <input
                        type="text"
                        name="code"
                        id="code"
                        required
                        autocomplete="one-time-code"
                        inputmode={useBackup ? "text" : "numeric"}
                        placeholder={useBackup ? "XXXXXXXX" : "000000"}
                        maxlength={useBackup ? 8 : 6}
                        class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-center text-lg tracking-widest shadow-sm focus:border-blue-500 focus:ring-blue-500 focus:outline-none" />
                </div>

                <button
                    type="submit"
                    class="flex w-full justify-center rounded-md border border-transparent bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none">
                    {t("mfa_login.confirm")}
                </button>
            </form>

            <div class="mt-4 text-center">
                <button type="button" onclick={() => (useBackup = !useBackup)} class="text-sm text-blue-600 hover:underline">
                    {useBackup ? t("mfa_login.use_totp") : t("mfa_login.use_backup")}
                </button>
            </div>

            <div class="mt-3 text-center">
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                <a href={loginHref} class="text-sm text-gray-500 hover:underline">{t("mfa_login.back_to_login")}</a>
            </div>
        </div>
    </div>
{/if}
