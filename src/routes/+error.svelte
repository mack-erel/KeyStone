<script lang="ts">
import { page } from "$app/state";
import { resolve } from "$app/paths";

const status = $derived(page.status);
const message = $derived(page.error?.message ?? "");

const title = $derived(status === 404 ? "페이지를 찾을 수 없습니다" : status === 403 ? "접근 권한이 없습니다" : status === 503 ? "서비스를 일시적으로 사용할 수 없습니다" : "문제가 발생했습니다");
</script>

<div class="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
    <p class="text-5xl font-bold text-gray-300">{status}</p>
    <h1 class="mt-4 text-xl font-semibold text-gray-900">{title}</h1>
    {#if message && message !== title}
        <p class="mt-2 max-w-md text-sm text-gray-500">{message}</p>
    {/if}
    <a href={resolve("/")} class="mt-6 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">홈으로 돌아가기</a>
</div>
