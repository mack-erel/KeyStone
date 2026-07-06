<script lang="ts">
import { enhance } from "$app/forms";
import { resolve } from "$app/paths";
import { onMount } from "svelte";
import type { SubmitFunction } from "@sveltejs/kit";
import { t } from "$lib/i18n.svelte";
import FormError from "$lib/components/FormError.svelte";
import LocaleToggle from "$lib/components/LocaleToggle.svelte";
import type { ActionData, PageData } from "./$types";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();
const err = $derived((form as { error?: string } | null)?.error ?? null);

let submitting = $state(false);
const enhanceSubmit: SubmitFunction = () => {
    submitting = true;
    return async ({ update }) => {
        await update({ reset: false });
        submitting = false;
    };
};

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

const findPasswordHref = $derived(
    (() => {
        const parts: string[] = [];
        if (data.redirectTo) parts.push(`redirectTo=${encodeURIComponent(data.redirectTo)}`);
        if (data.skinHint) parts.push(`skinHint=${encodeURIComponent(data.skinHint)}`);
        return resolve("/find-password") + (parts.length ? `?${parts.join("&")}` : "");
    })(),
);
</script>

{#if skinHtmlEffective}
    {#if !data.valid}
        <div class="fixed top-4 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-lg">
            {t("reset_password.invalid_link")}
        </div>
    {/if}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html skinHtmlEffective}
{:else}
    <div class="fixed top-4 right-4 z-40"><LocaleToggle /></div>
    <div class="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <div class="w-full max-w-md space-y-6 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
            <div>
                <h1 class="text-2xl font-bold text-gray-900">{t("reset_password.title")}</h1>
                <p class="mt-1 text-sm text-gray-500">{t("reset_password.subtitle")}</p>
            </div>

            {#if !data.valid}
                <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                    {t("reset_password.invalid_link")}
                </div>
                <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                <a href={findPasswordHref} class="block text-center text-sm text-blue-600 hover:underline">
                    {t("find_password.title")} →
                </a>
            {:else}
                <FormError message={err} />
                <form method="POST" use:enhance={enhanceSubmit} class="space-y-4">
                    <input type="hidden" name="token" value={data.token} />
                    {#if data.redirectTo}<input type="hidden" name="redirectTo" value={data.redirectTo} />{/if}
                    {#if data.skinHint}<input type="hidden" name="skinHint" value={data.skinHint} />{/if}
                    <div>
                        <label for="password" class="block text-sm font-medium text-gray-700">{t("reset_password.password_label")}</label>
                        <input
                            id="password"
                            name="password"
                            type="password"
                            required
                            autocomplete="new-password"
                            placeholder={t("reset_password.password_placeholder")}
                            class="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                    </div>
                    <div>
                        <label for="confirmPassword" class="block text-sm font-medium text-gray-700">{t("reset_password.confirm_label")}</label>
                        <input
                            id="confirmPassword"
                            name="confirmPassword"
                            type="password"
                            required
                            autocomplete="new-password"
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
                            {t("reset_password.submit")}
                        {/if}
                    </button>
                </form>
            {/if}
        </div>
    </div>
{/if}
