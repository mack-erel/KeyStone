<script lang="ts">
import { resolve } from "$app/paths";
import { t } from "$lib/i18n.svelte";
import type { ActionData, PageData } from "./$types";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();
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
        <div class="w-full max-w-md space-y-4 rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
            <h1 class="text-2xl font-bold text-gray-900">{t("find_password.title")}</h1>
            <p class="text-sm text-gray-500">{t("find_password.not_available")}</p>
            <a href={resolve("/login")} class="inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                {t("login.submit")}
            </a>
        </div>
    </div>
{/if}
