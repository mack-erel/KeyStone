<script lang="ts">
import { enhance } from "$app/forms";
import { resolve } from "$app/paths";
import { onMount } from "svelte";
import type { SubmitFunction } from "@sveltejs/kit";
import { t } from "$lib/i18n.svelte";
import FormError from "$lib/components/FormError.svelte";
import type { ActionData, PageData } from "./$types";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();
const result = $derived(form as { sent?: boolean; error?: string } | null);

let submitting = $state(false);
const enhanceSubmit: SubmitFunction = () => {
    submitting = true;
    return async ({ update }) => {
        await update({ reset: false });
        submitting = false;
    };
};

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
                <h1 class="text-2xl font-bold text-gray-900">{t("find_password.title")}</h1>
                <p class="mt-1 text-sm text-gray-500">{t("find_password.subtitle")}</p>
            </div>

            <FormError message={result?.error} />

            {#if result?.sent}
                <div class="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
                    {t("find_password.result_sent")}
                </div>
            {:else}
                <form method="POST" use:enhance={enhanceSubmit} class="space-y-4">
                    <div>
                        <label for="username" class="block text-sm font-medium text-gray-700">{t("find_password.username_label")}</label>
                        <input
                            id="username"
                            name="username"
                            type="text"
                            required
                            autocomplete="username"
                            class="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                    </div>
                    <div>
                        <label for="email" class="block text-sm font-medium text-gray-700">{t("find_password.email_label")}</label>
                        <input
                            id="email"
                            name="email"
                            type="email"
                            required
                            autocomplete="email"
                            class="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                    </div>
                    <button
                        type="submit"
                        disabled={submitting}
                        class="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">
                        {#if submitting}
                            <svg class="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                            </svg>
                            {t("common.processing")}
                        {:else}
                            {t("find_password.submit")}
                        {/if}
                    </button>
                </form>
            {/if}

            <div class="flex justify-center gap-4 text-sm text-gray-500">
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                <a href={resolve("/login") + authLinkSuffix} class="hover:text-blue-600">{t("login.submit")}</a>
                <span>·</span>
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                <a href={resolve("/find-id") + authLinkSuffix} class="hover:text-blue-600">{t("find_id.title")}</a>
            </div>
        </div>
    </div>
{/if}
