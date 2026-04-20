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
        <div class="w-full max-w-md space-y-6 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
            <div>
                <h1 class="text-2xl font-bold text-gray-900">{t("signup.title")}</h1>
                <p class="mt-1 text-sm text-gray-500">{t("signup.subtitle")}</p>
            </div>

            {#if form?.error}
                <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{form.error}</div>
            {/if}

            <form method="POST" class="space-y-4">
                <div>
                    <label for="username" class="block text-sm font-medium text-gray-700">{t("signup.username_label")}</label>
                    <input
                        id="username"
                        name="username"
                        type="text"
                        required
                        autocomplete="username"
                        placeholder="영문 소문자, 숫자, _ (3~32자)"
                        class="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                    <label for="email" class="block text-sm font-medium text-gray-700">{t("signup.email_label")}</label>
                    <input
                        id="email"
                        name="email"
                        type="email"
                        required
                        autocomplete="email"
                        class="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                    <label for="password" class="block text-sm font-medium text-gray-700">{t("signup.password_label")}</label>
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
                    <label for="confirmPassword" class="block text-sm font-medium text-gray-700">{t("signup.confirm_password_label")}</label>
                    <input
                        id="confirmPassword"
                        name="confirmPassword"
                        type="password"
                        required
                        autocomplete="new-password"
                        class="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <button type="submit" class="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700">
                    {t("signup.submit")}
                </button>
            </form>

            <p class="text-center text-sm text-gray-500">
                {t("signup.have_account")}
                <a href={resolve("/login")} class="text-blue-600 hover:underline">{t("login.submit")}</a>
            </p>
        </div>
    </div>
{/if}
