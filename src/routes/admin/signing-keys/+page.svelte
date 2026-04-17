<script lang="ts">
import { enhance } from "$app/forms";
import type { ActionData, PageData } from "./$types";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();

const dateFormatter = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" });
const dateTimeFormatter = new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
});

const rotated = $derived((form as { rotated?: boolean } | null)?.rotated ?? false);
const newKid = $derived((form as { newKid?: string } | null)?.newKid ?? null);
const globalErr = $derived((form as { error?: string } | null)?.error ?? null);
</script>

<div class="space-y-6">
    <div class="flex items-center justify-between">
        <h1 class="text-2xl font-bold text-gray-900">서명 키 관리</h1>
        <form method="POST" action="?/rotate" use:enhance>
            <button
                type="submit"
                class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
                onclick={(e) => {
                    if (!confirm("새 키를 생성하고 기존 활성 키를 비활성화합니다.\n계속하시겠습니까?")) e.preventDefault();
                }}>
                키 로테이션
            </button>
        </form>
    </div>

    {#if rotated && newKid}
        <div class="rounded-xl border border-green-200 bg-green-50 p-4">
            <p class="mb-1 font-semibold text-green-900">키 로테이션이 완료되었습니다</p>
            <p class="text-xs text-green-700">
                새 KID: <code class="rounded bg-white px-1.5 py-0.5 font-mono">{newKid}</code>
            </p>
        </div>
    {/if}

    {#if globalErr}
        <div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {globalErr}
        </div>
    {/if}

    <div class="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
                <tr>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">KID</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">알고리즘</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">용도</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">인증서</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">상태</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">생성일</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">로테이션</th>
                    <th class="px-4 py-3 text-left text-xs font-medium tracking-wider text-gray-500 uppercase">만료일</th>
                </tr>
            </thead>
            <tbody class="divide-y divide-gray-200">
                {#if data.keys.length === 0}
                    <tr>
                        <td colspan="8" class="px-6 py-8 text-center text-sm text-gray-500"> 등록된 서명 키가 없습니다. 키 로테이션 버튼을 눌러 첫 번째 키를 생성하세요. </td>
                    </tr>
                {:else}
                    {#each data.keys as key (key.id)}
                        <tr class="hover:bg-gray-50 {key.active ? '' : 'opacity-60'}">
                            <td class="max-w-40 truncate px-4 py-3 font-mono text-xs text-gray-700" title={key.kid}>{key.kid}</td>
                            <td class="px-4 py-3 text-xs text-gray-600">{key.alg}</td>
                            <td class="px-4 py-3 text-xs text-gray-600">{key.use ?? "sig"}</td>
                            <td class="px-4 py-3 text-xs">
                                {#if key.hasCert}
                                    <span class="rounded bg-blue-50 px-1.5 py-0.5 text-blue-600">있음</span>
                                {:else}
                                    <span class="text-gray-400">없음</span>
                                {/if}
                            </td>
                            <td class="px-4 py-3">
                                <span class="rounded-full px-2 py-0.5 text-xs font-medium {key.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}">
                                    {key.active ? "활성" : "비활성"}
                                </span>
                            </td>
                            <td class="px-4 py-3 text-xs text-gray-400">{dateFormatter.format(key.createdAt)}</td>
                            <td class="px-4 py-3 text-xs text-gray-400">
                                {key.rotatedAt ? dateTimeFormatter.format(key.rotatedAt) : "—"}
                            </td>
                            <td class="px-4 py-3 text-xs text-gray-400">
                                {key.notAfter ? dateFormatter.format(key.notAfter) : "—"}
                            </td>
                        </tr>
                    {/each}
                {/if}
            </tbody>
        </table>
    </div>
</div>
