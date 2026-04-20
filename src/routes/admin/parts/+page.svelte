<script lang="ts">
import { enhance } from "$app/forms";
import type { ActionData, PageData } from "./$types";
import { t } from "$lib/i18n.svelte";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();

let showCreate = $state(false);
let editId = $state<string | null>(null);

const err = $derived((form as { error?: string } | null)?.error ?? null);
const createErr = $derived((form as { create?: boolean; error?: string } | null)?.create ? err : null);

const STATUS_COLOR: Record<string, string> = {
    active: "bg-green-100 text-green-700",
    inactive: "bg-gray-100 text-gray-500",
};

function teamLabel(tm: { name: string; departmentName: string | null }) {
    return tm.departmentName ? `${tm.departmentName} / ${tm.name}` : tm.name;
}
</script>

<div class="space-y-6">
    <div class="flex items-center justify-between">
        <h1 class="text-2xl font-bold text-gray-900">{t("parts.title")}</h1>
        <button type="button" onclick={() => (showCreate = !showCreate)} class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700">
            {showCreate ? t("common.cancel") : t("parts.add_btn")}
        </button>
    </div>

    {#if showCreate}
        <div class="rounded-xl border border-blue-100 bg-blue-50 p-5">
            <h2 class="mb-4 font-semibold text-blue-900">{t("parts.create_title")}</h2>
            {#if createErr}
                <p class="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {createErr}
                </p>
            {/if}
            <form
                method="POST"
                action="?/create"
                use:enhance={() =>
                    ({ result, update }) => {
                        update();
                        if (result.type === "success") showCreate = false;
                    }}
                class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                    <label for="part-name" class="block text-xs font-medium text-gray-700">{t("parts.name_label")}</label>
                    <input
                        id="part-name"
                        type="text"
                        name="name"
                        required
                        placeholder="예: iOS파트"
                        class="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                    <label for="part-code" class="block text-xs font-medium text-gray-700">{t("common.code")}</label>
                    <input
                        id="part-code"
                        type="text"
                        name="code"
                        placeholder="예: IOS"
                        class="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                    <label for="part-teamId" class="block text-xs font-medium text-gray-700">{t("parts.team_label")}</label>
                    <select id="part-teamId" name="teamId" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none">
                        <option value="">{t("parts.team_none")}</option>
                        {#each data.allTeams as tm (tm.id)}
                            <option value={tm.id}>{teamLabel(tm)}</option>
                        {/each}
                    </select>
                </div>
                <div>
                    <label for="part-description" class="block text-xs font-medium text-gray-700">{t("common.description")}</label>
                    <input id="part-description" type="text" name="description" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div class="flex justify-end sm:col-span-2">
                    <button type="submit" class="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700">{t("common.add")}</button>
                </div>
            </form>
        </div>
    {/if}

    {#if err && !createErr}
        <p class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {err}
        </p>
    {/if}

    <div class="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
                <tr>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">{t("parts.col_name")}</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">{t("common.code")}</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">{t("parts.col_team")}</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">{t("parts.col_dept")}</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">{t("common.status")}</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">{t("common.actions")}</th>
                </tr>
            </thead>
            <tbody class="divide-y divide-gray-200">
                {#if data.parts.length === 0}
                    <tr><td colspan="6" class="px-6 py-8 text-center text-sm text-gray-500">{t("parts.empty")}</td></tr>
                {:else}
                    {#each data.parts as part (part.id)}
                        <tr class="hover:bg-gray-50">
                            {#if editId === part.id}
                                <td colspan="5" class="px-4 py-3">
                                    <form
                                        method="POST"
                                        action="?/update"
                                        use:enhance={() =>
                                            ({ result, update }) => {
                                                update();
                                                if (result.type === "success") editId = null;
                                            }}
                                        class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                        <input type="hidden" name="id" value={part.id} />
                                        <input type="text" name="name" value={part.name} required placeholder="파트명" class="rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none" />
                                        <input type="text" name="code" value={part.code ?? ""} placeholder="코드" class="rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none" />
                                        <select name="teamId" class="rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none">
                                            <option value="">{t("parts.team_none")}</option>
                                            {#each data.allTeams as tm (tm.id)}
                                                <option value={tm.id} selected={part.teamId === tm.id}>{teamLabel(tm)}</option>
                                            {/each}
                                        </select>
                                        <select name="status" class="rounded border border-gray-300 px-2 py-1 text-sm focus:outline-none">
                                            <option value="active" selected={part.status === "active"}>{t("common.status_active")}</option>
                                            <option value="inactive" selected={part.status === "inactive"}>{t("common.status_inactive")}</option>
                                        </select>
                                        <div class="col-span-2 flex gap-2 sm:col-span-4">
                                            <button type="submit" class="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700">{t("common.save")}</button>
                                            <button type="button" onclick={() => (editId = null)} class="text-xs text-gray-400 hover:text-gray-600">{t("common.cancel")}</button>
                                        </div>
                                    </form>
                                </td>
                            {:else}
                                <td class="px-4 py-3 text-sm font-medium text-gray-900">{part.name}</td>
                                <td class="px-4 py-3 text-sm text-gray-500">{part.code ?? "-"}</td>
                                <td class="px-4 py-3 text-sm text-gray-500">{part.teamName ?? "-"}</td>
                                <td class="px-4 py-3 text-sm text-gray-500">{part.departmentName ?? "-"}</td>
                                <td class="px-4 py-3">
                                    <span class="rounded-full px-2 py-0.5 text-xs font-medium {STATUS_COLOR[part.status]}">{t(`common.status_${part.status}`)}</span>
                                </td>
                            {/if}
                            <td class="px-4 py-3">
                                <div class="flex gap-2">
                                    <button type="button" onclick={() => (editId = editId === part.id ? null : part.id)} class="text-xs text-blue-500 hover:text-blue-700">{t("common.edit")}</button>
                                    <form method="POST" action="?/delete" use:enhance>
                                        <input type="hidden" name="id" value={part.id} />
                                        <button
                                            type="submit"
                                            class="text-xs text-red-400 hover:text-red-600"
                                            onclick={(e) => {
                                                if (!confirm(t("common.confirm_delete"))) e.preventDefault();
                                            }}>{t("common.delete")}</button>
                                    </form>
                                </div>
                            </td>
                        </tr>
                    {/each}
                {/if}
            </tbody>
        </table>
    </div>
</div>
