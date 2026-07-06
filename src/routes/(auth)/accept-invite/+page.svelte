<script lang="ts">
import { resolve } from "$app/paths";
import { t } from "$lib/i18n.svelte";
import LocaleToggle from "$lib/components/LocaleToggle.svelte";
import type { ActionData, PageData } from "./$types";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();
const err = $derived((form as { error?: string } | null)?.error ?? null);
const accepted = $derived((form as { accepted?: boolean } | null)?.accepted ?? false);
</script>

<div class="fixed top-4 right-4 z-40"><LocaleToggle /></div>
<div class="flex min-h-screen items-center justify-center bg-gray-50 p-4">
    <div class="w-full max-w-md space-y-6 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <div>
            <h1 class="text-2xl font-bold text-gray-900">{t("accept_invite.title")}</h1>
            <p class="mt-1 text-sm text-gray-500">{t("accept_invite.subtitle")}</p>
        </div>

        {#if accepted}
            <div class="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-700">
                {t("accept_invite.success")}
            </div>
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
            <a href={resolve("/login")} class="block text-center text-sm text-blue-600 hover:underline">
                {t("accept_invite.go_login")} →
            </a>
        {:else if data.valid}
            {#if err}
                <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</div>
            {/if}
            <form method="POST" class="space-y-4">
                <input type="hidden" name="token" value={data.token} />
                <div>
                    <label for="password" class="block text-sm font-medium text-gray-700">{t("accept_invite.password_label")}</label>
                    <input
                        id="password"
                        name="password"
                        type="password"
                        required
                        minlength="8"
                        autocomplete="new-password"
                        placeholder={t("accept_invite.password_placeholder")}
                        class="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                    <label for="confirmPassword" class="block text-sm font-medium text-gray-700">{t("accept_invite.confirm_label")}</label>
                    <input
                        id="confirmPassword"
                        name="confirmPassword"
                        type="password"
                        required
                        minlength="8"
                        autocomplete="new-password"
                        class="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <button type="submit" class="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700">
                    {t("accept_invite.submit")}
                </button>
            </form>
        {:else}
            <div class="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                {t("accept_invite.invalid_link")}
            </div>
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
            <a href={resolve("/login")} class="block text-center text-sm text-blue-600 hover:underline">
                {t("accept_invite.go_login")} →
            </a>
        {/if}
    </div>
</div>
