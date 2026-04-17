<script lang="ts">
import { enhance } from "$app/forms";
import type { ActionData, PageData } from "./$types";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();

const dateFormatter = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" });

let showCreate = $state(false);
let editingId = $state<string | null>(null);

// 생성/시크릿 재생성 직후 노출
const newSecret = $derived((form as { clientSecret?: string } | null)?.clientSecret ?? null);
const newClientId = $derived((form as { clientId?: string } | null)?.clientId ?? null);
const createErr = $derived((form as { create?: boolean; error?: string } | null)?.create ? ((form as { error?: string } | null)?.error ?? null) : null);
const globalErr = $derived(createErr ? null : ((form as { error?: string } | null)?.error ?? null));

function urisToText(json: string | null): string {
    if (!json) return "";
    try {
        return (JSON.parse(json) as string[]).join("\n");
    } catch {
        return json;
    }
}
</script>

<div class="space-y-6">
    <div class="flex items-center justify-between">
        <h1 class="text-2xl font-bold text-gray-900">OIDC 클라이언트</h1>
        <button
            type="button"
            onclick={() => {
                showCreate = !showCreate;
                editingId = null;
            }}
            class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700">
            {showCreate ? "취소" : "+ 클라이언트 추가"}
        </button>
    </div>

    <!-- 생성 성공 — 시크릿 1회 노출 -->
    {#if newSecret && newClientId}
        <div class="rounded-xl border border-green-200 bg-green-50 p-4">
            <p class="mb-1 font-semibold text-green-900">클라이언트가 생성되었습니다</p>
            <p class="mb-2 text-xs text-green-700">시크릿은 지금만 표시됩니다. 안전한 곳에 저장해 두세요.</p>
            <div class="space-y-1">
                <div class="flex items-center gap-2">
                    <span class="w-28 text-xs text-gray-500">Client ID</span>
                    <code class="rounded bg-white px-2 py-1 font-mono text-sm text-gray-800">{newClientId}</code>
                </div>
                <div class="flex items-center gap-2">
                    <span class="w-28 text-xs text-gray-500">Client Secret</span>
                    <code class="rounded bg-white px-2 py-1 font-mono text-sm break-all text-gray-800">{newSecret}</code>
                </div>
            </div>
        </div>
    {:else if (form as { regenerateSecret?: boolean } | null)?.regenerateSecret && newSecret}
        <div class="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p class="mb-1 font-semibold text-amber-900">시크릿이 재생성되었습니다</p>
            <p class="mb-2 text-xs text-amber-700">기존 시크릿은 더 이상 사용할 수 없습니다.</p>
            <code class="rounded bg-white px-2 py-1 font-mono text-sm break-all text-gray-800">{newSecret}</code>
        </div>
    {/if}

    <!-- 전역 에러 -->
    {#if globalErr}
        <div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {globalErr}
        </div>
    {/if}

    <!-- 생성 폼 -->
    {#if showCreate}
        <div class="rounded-xl border border-blue-100 bg-blue-50 p-5">
            <h2 class="mb-4 font-semibold text-blue-900">새 OIDC 클라이언트</h2>
            {#if createErr}
                <div class="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {createErr}
                </div>
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
                    <label for="c-name" class="block text-xs font-medium text-gray-700">이름 *</label>
                    <input id="c-name" type="text" name="name" required class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                    <label for="c-scopes" class="block text-xs font-medium text-gray-700">Scopes</label>
                    <input
                        id="c-scopes"
                        type="text"
                        name="scopes"
                        value="openid profile email"
                        class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div class="sm:col-span-2">
                    <label for="c-redirectUris" class="block text-xs font-medium text-gray-700">Redirect URIs * (줄바꿈 구분)</label>
                    <textarea
                        id="c-redirectUris"
                        name="redirectUris"
                        required
                        rows="3"
                        class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"></textarea>
                </div>
                <div class="sm:col-span-2">
                    <label for="c-postLogout" class="block text-xs font-medium text-gray-700">Post-Logout Redirect URIs (줄바꿈 구분)</label>
                    <textarea
                        id="c-postLogout"
                        name="postLogoutRedirectUris"
                        rows="2"
                        class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"></textarea>
                </div>
                <div>
                    <label for="c-authMethod" class="block text-xs font-medium text-gray-700">인증 방식</label>
                    <select id="c-authMethod" name="tokenEndpointAuthMethod" class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none">
                        <option value="client_secret_basic">client_secret_basic</option>
                        <option value="client_secret_post">client_secret_post</option>
                        <option value="none">none (공개 클라이언트)</option>
                    </select>
                </div>
                <div class="flex items-center gap-2 pt-5">
                    <input id="c-pkce" type="checkbox" name="requirePkce" value="true" checked class="h-4 w-4 rounded border-gray-300 text-blue-600" />
                    <label for="c-pkce" class="text-xs text-gray-700">PKCE 필수</label>
                </div>
                <div class="flex justify-end sm:col-span-2">
                    <button type="submit" class="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700">추가</button>
                </div>
            </form>
        </div>
    {/if}

    <!-- 테이블 -->
    <div class="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
                <tr>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">이름 / Client ID</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">Scopes</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">인증</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">상태</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">생성</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">작업</th>
                </tr>
            </thead>
            <tbody class="divide-y divide-gray-200">
                {#if data.clients.length === 0}
                    <tr>
                        <td colspan="6" class="px-6 py-8 text-center text-sm text-gray-500">등록된 클라이언트가 없습니다.</td>
                    </tr>
                {:else}
                    {#each data.clients as client (client.id)}
                        <tr class="hover:bg-gray-50">
                            <td class="px-4 py-3">
                                <p class="text-sm font-medium text-gray-900">{client.name}</p>
                                <p class="font-mono text-xs text-gray-400">{client.clientId}</p>
                            </td>
                            <td class="px-4 py-3 text-xs text-gray-600">{client.scopes}</td>
                            <td class="px-4 py-3 text-xs text-gray-500">{client.tokenEndpointAuthMethod}</td>
                            <td class="px-4 py-3">
                                <span class="rounded-full px-2 py-0.5 text-xs font-medium {client.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}">
                                    {client.enabled ? "활성" : "비활성"}
                                </span>
                            </td>
                            <td class="px-4 py-3 text-xs text-gray-400">{dateFormatter.format(client.createdAt)}</td>
                            <td class="px-4 py-3">
                                <div class="flex items-center gap-2">
                                    <button type="button" onclick={() => (editingId = editingId === client.id ? null : client.id)} class="text-xs text-blue-500 hover:text-blue-700">
                                        {editingId === client.id ? "접기" : "편집"}
                                    </button>
                                    <form method="POST" action="?/regenerateSecret" use:enhance>
                                        <input type="hidden" name="id" value={client.id} />
                                        <button
                                            type="submit"
                                            class="text-xs text-amber-500 hover:text-amber-700"
                                            onclick={(e) => {
                                                if (!confirm("시크릿을 재생성하시겠습니까? 기존 시크릿은 즉시 무효화됩니다.")) e.preventDefault();
                                            }}>
                                            시크릿 재생성
                                        </button>
                                    </form>
                                    <form method="POST" action="?/delete" use:enhance>
                                        <input type="hidden" name="id" value={client.id} />
                                        <button
                                            type="submit"
                                            class="text-xs text-red-400 hover:text-red-600"
                                            onclick={(e) => {
                                                if (!confirm("클라이언트를 삭제하시겠습니까?")) e.preventDefault();
                                            }}>
                                            삭제
                                        </button>
                                    </form>
                                </div>
                            </td>
                        </tr>

                        <!-- 편집 인라인 폼 -->
                        {#if editingId === client.id}
                            <tr class="bg-gray-50">
                                <td colspan="6" class="px-4 py-4">
                                    <form
                                        method="POST"
                                        action="?/update"
                                        use:enhance={() =>
                                            ({ result, update }) => {
                                                update();
                                                if (result.type === "success") editingId = null;
                                            }}
                                        class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        <input type="hidden" name="id" value={client.id} />
                                        <div>
                                            <label for="e-name-{client.id}" class="block text-xs font-medium text-gray-700">이름 *</label>
                                            <input
                                                id="e-name-{client.id}"
                                                type="text"
                                                name="name"
                                                value={client.name}
                                                required
                                                class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
                                        </div>
                                        <div>
                                            <label for="e-scopes-{client.id}" class="block text-xs font-medium text-gray-700">Scopes</label>
                                            <input
                                                id="e-scopes-{client.id}"
                                                type="text"
                                                name="scopes"
                                                value={client.scopes}
                                                class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
                                        </div>
                                        <div class="sm:col-span-2">
                                            <label for="e-redirectUris-{client.id}" class="block text-xs font-medium text-gray-700">Redirect URIs * (줄바꿈 구분)</label>
                                            <textarea
                                                id="e-redirectUris-{client.id}"
                                                name="redirectUris"
                                                required
                                                rows="3"
                                                class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                                                >{urisToText(client.redirectUris)}</textarea>
                                        </div>
                                        <div class="sm:col-span-2">
                                            <label for="e-postLogout-{client.id}" class="block text-xs font-medium text-gray-700">Post-Logout Redirect URIs</label>
                                            <textarea
                                                id="e-postLogout-{client.id}"
                                                name="postLogoutRedirectUris"
                                                rows="2"
                                                class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                                                >{urisToText(client.postLogoutRedirectUris)}</textarea>
                                        </div>
                                        <div class="flex items-center gap-4">
                                            <div class="flex items-center gap-2">
                                                <input id="e-pkce-{client.id}" type="checkbox" name="requirePkce" value="true" checked={client.requirePkce} class="h-4 w-4 rounded border-gray-300" />
                                                <label for="e-pkce-{client.id}" class="text-xs text-gray-700">PKCE 필수</label>
                                            </div>
                                            <div class="flex items-center gap-2">
                                                <input id="e-enabled-{client.id}" type="checkbox" name="enabled" value="true" checked={client.enabled} class="h-4 w-4 rounded border-gray-300" />
                                                <label for="e-enabled-{client.id}" class="text-xs text-gray-700">활성</label>
                                            </div>
                                        </div>
                                        <div class="flex justify-end gap-2">
                                            <button type="button" onclick={() => (editingId = null)} class="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
                                                >취소</button>
                                            <button type="submit" class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">저장</button>
                                        </div>
                                    </form>
                                </td>
                            </tr>
                        {/if}
                    {/each}
                {/if}
            </tbody>
        </table>
    </div>
</div>
