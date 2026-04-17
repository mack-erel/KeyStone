<script lang="ts">
import { goto } from "$app/navigation";
import { t } from "$lib/i18n.svelte";
import type { ActionData, PageData } from "./$types";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();

let passkeyLoading = $state(false);
let passkeyError = $state("");

async function loginWithPasskey() {
    passkeyError = "";
    passkeyLoading = true;
    try {
        // 1. 인증 옵션 요청
        const optRes = await fetch("/api/webauthn/authenticate/options", { method: "POST" });
        if (!optRes.ok) throw new Error((await optRes.text()) || "옵션 요청 실패");
        const options = await optRes.json();

        // 2. 브라우저 패스키 인증 (클라이언트 전용)
        const { startAuthentication } = await import("@simplewebauthn/browser");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const authResponse = await startAuthentication({ optionsJSON: options as any });

        // 3. 검증 요청 — SAML/OIDC 플로우의 redirectTo 를 함께 전달
        const pendingRedirect = form?.redirectTo ?? data.redirectTo ?? "";
        const verRes = await fetch("/api/webauthn/authenticate/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...authResponse, _redirectTo: pendingRedirect }),
        });

        if (!verRes.ok) throw new Error((await verRes.text()) || "인증 실패");

        const { redirectTo } = (await verRes.json()) as { redirectTo?: string };
        // eslint-disable-next-line svelte/no-navigation-without-resolve
        await goto(redirectTo ?? "/");
    } catch (err: unknown) {
        const e = err as { name?: string; message?: string };
        if (e?.name === "NotAllowedError") {
            passkeyError = "패스키 인증이 취소되었습니다.";
        } else {
            passkeyError = e?.message ?? "패스키 인증에 실패했습니다.";
        }
    } finally {
        passkeyLoading = false;
    }
}
</script>

<div class="flex min-h-screen items-center justify-center bg-gray-50 p-4">
    <div class="w-full max-w-105 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <div class="mb-6 space-y-2 text-center">
            <h1 class="text-2xl font-bold text-gray-900">{t("app.title")}</h1>
            <p class="text-sm leading-6 text-gray-500">M0 관리자 진입용 로컬 계정 로그인입니다.</p>
        </div>

        {#if !data.dbReady && data.runtimeError}
            <div class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                {data.runtimeError}
            </div>
        {/if}

        {#if form?.error}
            <div class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {form.error}
            </div>
        {/if}

        {#if passkeyError}
            <div class="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {passkeyError}
            </div>
        {/if}

        <form method="POST" class="space-y-4">
            <input type="hidden" name="redirectTo" value={form?.redirectTo ?? data.redirectTo ?? ""} />

            <div>
                <label for="username" class="block text-sm font-medium text-gray-700">
                    {t("login.username")}
                </label>
                <input
                    type="text"
                    name="username"
                    id="username"
                    required
                    autocomplete="username"
                    value={form?.username ?? ""}
                    class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:ring-blue-500 focus:outline-none sm:text-sm" />
            </div>

            <div>
                <label for="password" class="block text-sm font-medium text-gray-700">
                    {t("login.password")}
                </label>
                <input
                    type="password"
                    name="password"
                    id="password"
                    required
                    autocomplete="current-password"
                    class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:ring-blue-500 focus:outline-none sm:text-sm" />
            </div>

            <button
                type="submit"
                class="flex w-full justify-center rounded-md border border-transparent bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none">
                {t("login.submit")}
            </button>
        </form>

        <div class="mt-4 flex items-center gap-3">
            <div class="h-px flex-1 bg-gray-200"></div>
            <span class="text-xs text-gray-400">또는</span>
            <div class="h-px flex-1 bg-gray-200"></div>
        </div>

        <button
            type="button"
            onclick={loginWithPasskey}
            disabled={passkeyLoading}
            class="mt-4 flex w-full items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition hover:bg-gray-50 disabled:opacity-60">
            {#if passkeyLoading}
                <svg class="h-4 w-4 animate-spin text-gray-500" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                인증 중...
            {:else}
                <svg class="h-4 w-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
                패스키로 로그인
            {/if}
        </button>
    </div>
</div>
