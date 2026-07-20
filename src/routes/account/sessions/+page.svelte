<script lang="ts">
import { enhance } from "$app/forms";
import type { ActionData, PageData } from "./$types";
import { t } from "$lib/i18n.svelte";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();

const formError = $derived((form as { error?: string } | null)?.error ?? null);
const revoked = $derived(Boolean((form as { revoked?: boolean } | null)?.revoked));
const revokedOthers = $derived(Boolean((form as { revokedOthers?: boolean } | null)?.revokedOthers));

function formatWhen(value: string | Date): string {
    return new Date(value).toLocaleString("ko-KR");
}

const otherCount = $derived(data.sessions.filter((s: (typeof data.sessions)[number]) => s.id !== data.currentSessionId).length);
</script>

<div class="min-h-screen bg-gray-50 p-4">
    <div class="mx-auto max-w-lg">
        <div class="mb-6">
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
            <a href="/" class="text-sm text-gray-500 hover:underline">← {t("mfa_manage.back_to_home")}</a>
        </div>

        <div class="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
            <h1 class="mb-1 text-2xl font-bold text-gray-900">{t("account.sessions.title")}</h1>
            <p class="mb-6 text-sm text-gray-500">{t("account.sessions.subtitle")}</p>

            {#if formError}
                <div class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {formError}
                </div>
            {/if}

            {#if revoked}
                <div class="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                    {t("account.sessions.revoked_notice")}
                </div>
            {/if}

            {#if revokedOthers}
                <div class="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
                    {t("account.sessions.revoked_others_notice")}
                </div>
            {/if}

            {#if data.sessions.length > 0}
                <div class="mb-6 space-y-2">
                    {#each data.sessions as s (s.id)}
                        {@const isCurrent = s.id === data.currentSessionId}
                        <div class="rounded-xl border border-gray-200 px-4 py-3" class:border-blue-300={isCurrent} class:bg-blue-50={isCurrent}>
                            <div class="flex items-start justify-between gap-3">
                                <div class="min-w-0">
                                    {#if isCurrent}
                                        <span class="mb-1 inline-block rounded-full bg-blue-600 px-2 py-0.5 text-xs font-medium text-white">
                                            {t("account.sessions.current_badge")}
                                        </span>
                                    {/if}
                                    <p class="truncate text-sm font-medium text-gray-900">
                                        {t("account.sessions.device_label")}: {s.userAgent ?? t("account.sessions.unknown")}
                                    </p>
                                    <p class="text-xs text-gray-400">
                                        {t("account.sessions.ip_label")}: {s.ip ?? t("account.sessions.unknown")}
                                    </p>
                                    <p class="text-xs text-gray-400">
                                        {t("account.sessions.last_seen_label")}: {formatWhen(s.lastSeenAt)}
                                    </p>
                                    <p class="text-xs text-gray-400">
                                        {t("account.sessions.created_label")}: {formatWhen(s.createdAt)}
                                    </p>
                                </div>

                                <form method="POST" action="?/revoke" use:enhance>
                                    <input type="hidden" name="id" value={s.id} />
                                    <button
                                        type="submit"
                                        class="shrink-0 text-sm text-red-500 hover:text-red-700"
                                        onclick={(e: MouseEvent) => {
                                            const msg = isCurrent ? t("account.sessions.revoke_current_confirm") : t("account.sessions.revoke_confirm");
                                            if (!confirm(msg)) {
                                                e.preventDefault();
                                            }
                                        }}>
                                        {isCurrent ? t("account.sessions.revoke_current") : t("account.sessions.revoke")}
                                    </button>
                                </form>
                            </div>
                        </div>
                    {/each}
                </div>
            {:else}
                <div class="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-4">
                    <p class="text-sm text-gray-500">{t("account.sessions.empty")}</p>
                </div>
            {/if}

            {#if otherCount > 0}
                <form method="POST" action="?/revokeOthers" use:enhance class="mb-3">
                    <button
                        type="submit"
                        class="w-full rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50"
                        onclick={(e: MouseEvent) => {
                            if (!confirm(t("account.sessions.revoke_others_confirm"))) {
                                e.preventDefault();
                            }
                        }}>
                        {t("account.sessions.revoke_others")}
                    </button>
                </form>
            {/if}

            {#if data.sessions.length > 0}
                <form method="POST" action="?/revokeAll" use:enhance>
                    <button
                        type="submit"
                        class="w-full rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-600 shadow-sm transition hover:bg-red-50"
                        onclick={(e: MouseEvent) => {
                            if (!confirm(t("account.sessions.revoke_all_confirm"))) {
                                e.preventDefault();
                            }
                        }}>
                        {t("account.sessions.revoke_all")}
                    </button>
                </form>
            {/if}
        </div>
    </div>
</div>
