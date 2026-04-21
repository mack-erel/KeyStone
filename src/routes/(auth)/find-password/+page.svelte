<script lang="ts">
import { resolve } from "$app/paths";
import { t } from "$lib/i18n.svelte";
import type { ActionData, PageData } from "./$types";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();
const result = $derived(form as { sent?: boolean; error?: string } | null);
</script>

{#if data.skinHtml}
    {#if form?.error}
        <div class="fixed top-4 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 shadow-lg">
            {form.error}
        </div>
    {/if}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    {@html data.skinHtml}
{:else}
    <div class="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <div class="w-full max-w-md space-y-6 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
            <div>
                <h1 class="text-2xl font-bold text-gray-900">{t("find_password.title")}</h1>
                <p class="mt-1 text-sm text-gray-500">{t("find_password.subtitle")}</p>
            </div>

            {#if result?.error}
                <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{result.error}</div>
            {/if}

            {#if result?.sent}
                <div class="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
                    {t("find_password.result_sent")}
                </div>
            {:else}
                <form method="POST" class="space-y-4">
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
                    <button type="submit" class="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700">
                        {t("find_password.submit")}
                    </button>
                </form>
            {/if}

            <div class="flex justify-center gap-4 text-sm text-gray-500">
                <a href={resolve("/login")} class="hover:text-blue-600">{t("login.submit")}</a>
                <span>·</span>
                <a href={resolve("/find-id")} class="hover:text-blue-600">{t("find_id.title")}</a>
            </div>
        </div>
    </div>
{/if}
