<script lang="ts">
import { enhance } from "$app/forms";
import { resolve } from "$app/paths";
import type { ActionData, PageData } from "./$types";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();

const err = $derived((form as { error?: string } | null)?.error ?? null);

let editingId = $state<string | null>(null);
</script>

<div class="max-w-3xl space-y-8">
    <div class="flex items-center gap-3">
        <a href={resolve("/admin/saml-sps")} class="text-sm text-gray-400 hover:text-gray-600">← SAML SP</a>
        <h1 class="text-2xl font-bold text-gray-900">{data.sp.name}</h1>
        <span class="font-mono text-xs break-all text-gray-400">{data.sp.entityId}</span>
    </div>

    {#if err}
        <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</div>
    {/if}

    <section class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div class="mb-4 flex items-center justify-between">
            <h2 class="text-sm font-semibold text-gray-700">Role 목록</h2>
            <span class="text-xs text-gray-400">{data.roles.length} 개</span>
        </div>

        {#if data.roles.length > 0}
            <div class="mb-4 divide-y divide-gray-100 rounded-lg border border-gray-200">
                {#each data.roles as r (r.id)}
                    <div class="px-4 py-3 text-sm">
                        {#if editingId === r.id}
                            <form method="POST" action="?/updateRole" use:enhance={() => ({ result, update }) => { update(); if (result.type === "success") editingId = null; }} class="grid grid-cols-2 gap-2 sm:grid-cols-5">
                                <input type="hidden" name="roleId" value={r.id} />
                                <label class="block text-xs text-gray-500 sm:col-span-1">
                                    key
                                    <input type="text" value={r.key} disabled class="mt-1 w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-xs text-gray-500" />
                                </label>
                                <label class="block text-xs text-gray-500 sm:col-span-1">
                                    label
                                    <input type="text" name="label" value={r.label} required class="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-xs" />
                                </label>
                                <label class="block text-xs text-gray-500 sm:col-span-2">
                                    description
                                    <input type="text" name="description" value={r.description ?? ""} class="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-xs" />
                                </label>
                                <label class="block text-xs text-gray-500 sm:col-span-1">
                                    order
                                    <input type="number" name="displayOrder" value={r.displayOrder} class="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-xs" />
                                </label>
                                <div class="flex items-center gap-2 sm:col-span-5">
                                    <label class="flex items-center gap-1 text-xs text-gray-600">
                                        <input type="checkbox" name="isDefault" value="true" checked={r.isDefault} class="rounded" /> default
                                    </label>
                                    <div class="ml-auto flex gap-2">
                                        <button type="button" onclick={() => (editingId = null)} class="rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600">취소</button>
                                        <button type="submit" class="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white">저장</button>
                                    </div>
                                </div>
                            </form>
                        {:else}
                            <div class="flex items-center justify-between">
                                <div class="flex flex-wrap items-center gap-2">
                                    <code class="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">{r.key}</code>
                                    <span class="font-medium text-gray-900">{r.label}</span>
                                    {#if r.isDefault}<span class="rounded-full bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">default</span>{/if}
                                    {#if r.description}<span class="text-xs text-gray-500">{r.description}</span>{/if}
                                    <span class="text-xs text-gray-300">order: {r.displayOrder}</span>
                                </div>
                                <div class="flex items-center gap-2">
                                    <button type="button" onclick={() => (editingId = r.id)} class="text-xs text-blue-500">편집</button>
                                    <form method="POST" action="?/deleteRole" use:enhance>
                                        <input type="hidden" name="roleId" value={r.id} />
                                        <button type="submit" class="text-xs text-red-400" onclick={(e) => { if (!confirm(`role '${r.key}' 을 삭제하시겠습니까? 이 role 이 부여된 사용자 매핑은 role 이 null 로 설정됩니다.`)) e.preventDefault(); }}>삭제</button>
                                    </form>
                                </div>
                            </div>
                        {/if}
                    </div>
                {/each}
            </div>
        {:else}
            <p class="mb-4 text-sm text-gray-400">등록된 role 이 없습니다.</p>
        {/if}

        <form method="POST" action="?/addRole" use:enhance class="grid grid-cols-2 gap-2 border-t border-gray-100 pt-4 sm:grid-cols-5">
            <input type="text" name="key" placeholder="key (예: admin)" required class="rounded-md border border-gray-300 px-2 py-1.5 text-sm font-mono" />
            <input type="text" name="label" placeholder="label" required class="rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
            <input type="text" name="description" placeholder="description (optional)" class="rounded-md border border-gray-300 px-2 py-1.5 text-sm sm:col-span-2" />
            <input type="number" name="displayOrder" value="0" class="rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
            <div class="flex items-center gap-2 sm:col-span-5">
                <label class="flex items-center gap-1 text-xs text-gray-600">
                    <input type="checkbox" name="isDefault" value="true" class="rounded" /> default
                </label>
                <button type="submit" class="ml-auto rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white">role 추가</button>
            </div>
        </form>
    </section>
</div>
