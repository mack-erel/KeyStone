<script lang="ts">
import { resolve } from "$app/paths";
import { t } from "$lib/i18n.svelte";
import type { ActionData, PageData } from "./$types";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();
const err = $derived((form as { error?: string } | null)?.error ?? null);

const findPasswordHref = $derived(
    (() => {
        const parts: string[] = [];
        if (data.redirectTo) parts.push(`redirectTo=${encodeURIComponent(data.redirectTo)}`);
        if (data.skinHint) parts.push(`skinHint=${encodeURIComponent(data.skinHint)}`);
        return resolve("/find-password") + (parts.length ? `?${parts.join("&")}` : "");
    })(),
);
</script>

{#if data.skinHtml}
    {#if err}
        <div class="fixed top-4 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-lg">
            {err}
        </div>
    {/if}
    {#if !data.valid}
        <div class="fixed top-4 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-lg">
            {t("reset_password.invalid_link")}
        </div>
    {/if}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html data.skinHtml}
{:else}
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
                {#if err}
                    <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</div>
                {/if}
                <form method="POST" class="space-y-4">
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
                            placeholder="8자 이상"
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
                    <button type="submit" class="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700">
                        {t("reset_password.submit")}
                    </button>
                </form>
            {/if}
        </div>
    </div>
{/if}
