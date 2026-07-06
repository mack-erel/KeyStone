<script lang="ts">
import { resolve } from "$app/paths";
import { t } from "$lib/i18n.svelte";
import LocaleToggle from "$lib/components/LocaleToggle.svelte";
import type { ActionData, PageData } from "./$types";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();
const err = $derived((form as { error?: string } | null)?.error ?? null);
const changed = $derived((form as { changed?: boolean } | null)?.changed ?? false);
</script>

<div class="fixed top-4 right-4 z-40"><LocaleToggle /></div>
<div class="flex min-h-screen items-center justify-center bg-gray-50 p-4">
    <div class="w-full max-w-md space-y-6 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <div>
            <h1 class="text-2xl font-bold text-gray-900">{t("confirm_email_change.title")}</h1>
            <p class="mt-1 text-sm text-gray-500">{t("confirm_email_change.subtitle")}</p>
        </div>

        {#if changed}
            <div class="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-700">
                {t("confirm_email_change.success")}
            </div>
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
            <a href={resolve("/account/profile")} class="block text-center text-sm text-blue-600 hover:underline">
                {t("confirm_email_change.go_profile")} →
            </a>
        {:else if data.valid}
            {#if err}
                <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</div>
            {/if}
            <p class="text-sm text-gray-600">{t("confirm_email_change.confirm_prompt")}</p>
            <form method="POST" class="space-y-4">
                <input type="hidden" name="token" value={data.token} />
                <button type="submit" class="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700">
                    {t("confirm_email_change.submit")}
                </button>
            </form>
        {:else}
            <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                {t("confirm_email_change.invalid_link")}
            </div>
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
            <a href={resolve("/login")} class="block text-center text-sm text-blue-600 hover:underline">
                {t("confirm_email_change.go_login")} →
            </a>
        {/if}
    </div>
</div>
