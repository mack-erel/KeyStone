<script lang="ts">
import { resolve } from "$app/paths";
import { onMount } from "svelte";
import { t } from "$lib/i18n.svelte";
import type { ActionData, PageData } from "./$types";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();
const result = $derived(form as { sent?: boolean; maskedUsername?: string | null; error?: string } | null);

onMount(() => {
    if (!data.skinHtml && !(form as { skinHtml?: string } | null)?.skinHtml) return;
    const s = document.createElement("script");
    s.src = "/api/skin-scripts";
    document.head.appendChild(s);
    return () => {
        if (s.parentNode) s.parentNode.removeChild(s);
    };
});

function buildAuthSuffix(redirectTo: string | null, skinHint: string | null): string {
    const parts: string[] = [];
    if (redirectTo) parts.push(`redirectTo=${encodeURIComponent(redirectTo)}`);
    if (skinHint) parts.push(`skinHint=${encodeURIComponent(skinHint)}`);
    return parts.length ? `?${parts.join("&")}` : "";
}

const authLinkSuffix = $derived(buildAuthSuffix(data.redirectTo ?? null, data.skinHint ?? null));
</script>

{#if data.skinHtml}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html form?.skinHtml ?? data.skinHtml}
{:else}
    <div class="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <div class="w-full max-w-md space-y-6 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
            <div>
                <h1 class="text-2xl font-bold text-gray-900">{t("find_id.title")}</h1>
                <p class="mt-1 text-sm text-gray-500">{t("find_id.subtitle")}</p>
            </div>

            {#if result?.error}
                <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{result.error}</div>
            {/if}

            {#if result?.sent}
                <div class="space-y-3 rounded-lg border border-green-200 bg-green-50 p-4">
                    {#if result.maskedUsername}
                        <p class="text-sm text-green-800">{t("find_id.result_found")}</p>
                        <p class="text-center font-mono text-xl font-bold text-gray-900">{result.maskedUsername}</p>
                        <p class="text-xs text-green-700">{t("find_id.result_email_sent")}</p>
                    {:else}
                        <p class="text-sm text-green-800">{t("find_id.result_not_found")}</p>
                    {/if}
                </div>
            {:else}
                <form method="POST" class="space-y-4">
                    <div>
                        <label for="email" class="block text-sm font-medium text-gray-700">{t("find_id.email_label")}</label>
                        <input
                            id="email"
                            name="email"
                            type="email"
                            required
                            autocomplete="email"
                            class="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                    </div>
                    <button type="submit" class="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700">
                        {t("find_id.submit")}
                    </button>
                </form>
            {/if}

            <div class="flex justify-center gap-4 text-sm text-gray-500">
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                <a href={resolve("/login") + authLinkSuffix} class="hover:text-blue-600">{t("login.submit")}</a>
                <span>·</span>
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                <a href={resolve("/find-password") + authLinkSuffix} class="hover:text-blue-600">{t("find_password.title")}</a>
            </div>
        </div>
    </div>
{/if}
