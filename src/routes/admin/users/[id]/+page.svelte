<script lang="ts">
import { enhance } from "$app/forms";
import { resolve } from "$app/paths";
import type { ActionData, PageData } from "./$types";
import { t } from "$lib/i18n.svelte";

const { data, form } = $props<{ data: PageData; form?: ActionData }>();

const err = $derived((form as { error?: string } | null)?.error ?? null);
const updated = $derived((form as { updated?: boolean } | null)?.updated ?? false);

const dateFormatter = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" });

function teamLabel(tm: { name: string; departmentName: string | null }) {
    return tm.departmentName ? `${tm.departmentName} / ${tm.name}` : tm.name;
}

function partLabel(p: { name: string; teamName: string | null }) {
    return p.teamName ? `${p.teamName} / ${p.name}` : p.name;
}

const LOCALE_OPTIONS = [
    { value: "ko-KR", label: "한국어" },
    { value: "en-US", label: "English (US)" },
    { value: "ja-JP", label: "日本語" },
];
const TIMEZONE_OPTIONS = [
    { value: "Asia/Seoul", label: "Asia/Seoul (KST)" },
    { value: "Asia/Tokyo", label: "Asia/Tokyo (JST)" },
    { value: "UTC", label: "UTC" },
    { value: "America/New_York", label: "America/New_York (EST)" },
];
</script>

<div class="max-w-3xl space-y-8">
    <div class="flex items-center gap-3">
        <a href={resolve("/admin/users")} class="text-sm text-gray-400 hover:text-gray-600">{t("user_detail.back")}</a>
        <h1 class="text-2xl font-bold text-gray-900">{data.user.displayName ?? data.user.email}</h1>
        <span class="text-sm text-gray-400">{data.user.email}</span>
    </div>

    {#if err}
        <div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {err}
        </div>
    {/if}
    {#if updated}
        <div class="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">{t("user_detail.saved")}</div>
    {/if}

    <section class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 class="mb-5 text-sm font-semibold text-gray-700">{t("user_detail.profile_section")}</h2>
        <form method="POST" action="?/updateProfile" use:enhance class="space-y-4">
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                    <label for="givenName" class="block text-xs font-medium text-gray-700">{t("user_detail.given_name")}</label>
                    <input
                        id="givenName"
                        type="text"
                        name="givenName"
                        value={data.user.givenName ?? ""}
                        class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                    <label for="familyName" class="block text-xs font-medium text-gray-700">{t("user_detail.family_name")}</label>
                    <input
                        id="familyName"
                        type="text"
                        name="familyName"
                        value={data.user.familyName ?? ""}
                        class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div class="sm:col-span-2">
                    <label for="displayName" class="block text-xs font-medium text-gray-700">{t("user_detail.display_name")}</label>
                    <input
                        id="displayName"
                        type="text"
                        name="displayName"
                        value={data.user.displayName ?? ""}
                        class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                    <label for="phoneNumber" class="block text-xs font-medium text-gray-700">{t("user_detail.phone")}</label>
                    <input
                        id="phoneNumber"
                        type="tel"
                        name="phoneNumber"
                        value={data.user.phoneNumber ?? ""}
                        placeholder="+82-10-0000-0000"
                        class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div>
                    <label for="birthdate" class="block text-xs font-medium text-gray-700">{t("user_detail.birthdate")}</label>
                    <input
                        id="birthdate"
                        type="date"
                        name="birthdate"
                        value={data.user.birthdate ?? ""}
                        class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
                </div>
                <div class="sm:col-span-2">
                    <label for="bio" class="block text-xs font-medium text-gray-700">{t("user_detail.bio")}</label>
                    <textarea id="bio" name="bio" rows="2" class="mt-1 w-full resize-none rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                        >{data.user.bio ?? ""}</textarea>
                </div>
                <div>
                    <label for="locale" class="block text-xs font-medium text-gray-700">{t("user_detail.locale")}</label>
                    <select id="locale" name="locale" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                        {#each LOCALE_OPTIONS as opt (opt.value)}
                            <option value={opt.value} selected={data.user.locale === opt.value}>{opt.label}</option>
                        {/each}
                    </select>
                </div>
                <div>
                    <label for="zoneinfo" class="block text-xs font-medium text-gray-700">{t("user_detail.timezone")}</label>
                    <select id="zoneinfo" name="zoneinfo" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                        {#each TIMEZONE_OPTIONS as opt (opt.value)}
                            <option value={opt.value} selected={data.user.zoneinfo === opt.value}>{opt.label}</option>
                        {/each}
                    </select>
                </div>
                <div>
                    <label for="role" class="block text-xs font-medium text-gray-700">{t("user_detail.role")}</label>
                    <select id="role" name="role" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                        <option value="user" selected={data.user.role === "user"}>{t("user_detail.role_user")}</option>
                        <option value="admin" selected={data.user.role === "admin"}>{t("user_detail.role_admin")}</option>
                    </select>
                </div>
                <div>
                    <label for="status" class="block text-xs font-medium text-gray-700">{t("user_detail.status")}</label>
                    <select id="status" name="status" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
                        <option value="active" selected={data.user.status === "active"}>{t("user_detail.status_active")}</option>
                        <option value="disabled" selected={data.user.status === "disabled"}>{t("user_detail.status_disabled")}</option>
                        <option value="locked" selected={data.user.status === "locked"}>{t("user_detail.status_locked")}</option>
                    </select>
                </div>
            </div>
            <div class="flex justify-end pt-2">
                <button type="submit" class="rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700">{t("common.save")}</button>
            </div>
        </form>
    </section>

    <section class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 class="mb-4 text-sm font-semibold text-gray-700">{t("user_detail.dept_section")}</h2>

        {#if data.deptMemberships.length > 0}
            <div class="mb-4 divide-y divide-gray-100 rounded-lg border border-gray-200">
                {#each data.deptMemberships as m (m.id)}
                    <div class="flex items-center justify-between px-4 py-2.5 text-sm">
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="font-medium text-gray-900">{m.departmentName}</span>
                            {#if m.isPrimary}<span class="rounded-full bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">{t("user_detail.primary")}</span>{/if}
                            {#if m.positionName}<span class="text-gray-500">{m.positionName}</span>{/if}
                            {#if m.jobTitle}<span class="text-gray-400">/ {m.jobTitle}</span>{/if}
                            <span class="text-xs text-gray-300">{dateFormatter.format(m.startedAt)} ~</span>
                        </div>
                        <form method="POST" action="?/removeDept" use:enhance>
                            <input type="hidden" name="membershipId" value={m.id} />
                            <button type="submit" class="text-xs text-red-400 hover:text-red-600">{t("common.remove")}</button>
                        </form>
                    </div>
                {/each}
            </div>
        {:else}
            <p class="mb-4 text-sm text-gray-400">{t("user_detail.dept_empty")}</p>
        {/if}

        <form method="POST" action="?/addDept" use:enhance class="grid grid-cols-2 gap-2 border-t border-gray-100 pt-4 sm:grid-cols-4">
            <select name="departmentId" required class="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none">
                <option value="">{t("user_detail.dept_select")}</option>
                {#each data.allDepts as d (d.id)}
                    <option value={d.id}>{d.name}</option>
                {/each}
            </select>
            <select name="positionId" class="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none">
                <option value="">{t("user_detail.position_none")}</option>
                {#each data.allPositions as p (p.id)}
                    <option value={p.id}>{p.name}</option>
                {/each}
            </select>
            <input
                type="text"
                name="jobTitle"
                placeholder={t("user_detail.job_title_placeholder")}
                class="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
            <div class="flex items-center gap-2">
                <label class="flex items-center gap-1 text-xs text-gray-600">
                    <input type="checkbox" name="isPrimary" value="true" class="rounded" />
                    {t("user_detail.primary")}
                </label>
                <button type="submit" class="ml-auto rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">{t("common.add")}</button>
            </div>
        </form>
    </section>

    <section class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 class="mb-4 text-sm font-semibold text-gray-700">{t("user_detail.team_section")}</h2>

        {#if data.teamMemberships.length > 0}
            <div class="mb-4 divide-y divide-gray-100 rounded-lg border border-gray-200">
                {#each data.teamMemberships as m (m.id)}
                    <div class="flex items-center justify-between px-4 py-2.5 text-sm">
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="font-medium text-gray-900">{m.teamName}</span>
                            {#if m.departmentName}<span class="text-xs text-gray-400">({m.departmentName})</span>{/if}
                            {#if m.isPrimary}<span class="rounded-full bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-700">{t("user_detail.primary")}</span>{/if}
                            {#if m.jobTitle}<span class="text-gray-400">/ {m.jobTitle}</span>{/if}
                            <span class="text-xs text-gray-300">{dateFormatter.format(m.startedAt)} ~</span>
                        </div>
                        <form method="POST" action="?/removeTeam" use:enhance>
                            <input type="hidden" name="membershipId" value={m.id} />
                            <button type="submit" class="text-xs text-red-400 hover:text-red-600">{t("common.remove")}</button>
                        </form>
                    </div>
                {/each}
            </div>
        {:else}
            <p class="mb-4 text-sm text-gray-400">{t("user_detail.team_empty")}</p>
        {/if}

        <form method="POST" action="?/addTeam" use:enhance class="grid grid-cols-2 gap-2 border-t border-gray-100 pt-4 sm:grid-cols-4">
            <select name="teamId" required class="col-span-2 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none sm:col-span-1">
                <option value="">{t("user_detail.team_select")}</option>
                {#each data.allTeams as tm (tm.id)}
                    <option value={tm.id}>{teamLabel(tm)}</option>
                {/each}
            </select>
            <input
                type="text"
                name="jobTitle"
                placeholder={t("user_detail.job_title_placeholder")}
                class="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
            <div class="flex items-center gap-2">
                <label class="flex items-center gap-1 text-xs text-gray-600">
                    <input type="checkbox" name="isPrimary" value="true" class="rounded" />
                    {t("user_detail.primary")}
                </label>
                <button type="submit" class="ml-auto rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">{t("common.add")}</button>
            </div>
        </form>
    </section>

    <section class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 class="mb-4 text-sm font-semibold text-gray-700">{t("user_detail.part_section")}</h2>

        {#if data.partMemberships.length > 0}
            <div class="mb-4 divide-y divide-gray-100 rounded-lg border border-gray-200">
                {#each data.partMemberships as m (m.id)}
                    <div class="flex items-center justify-between px-4 py-2.5 text-sm">
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="font-medium text-gray-900">{m.partName}</span>
                            {#if m.teamName}<span class="text-xs text-gray-400">({m.teamName})</span>{/if}
                            {#if m.isPrimary}<span class="rounded-full bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700">{t("user_detail.primary")}</span>{/if}
                            {#if m.jobTitle}<span class="text-gray-400">/ {m.jobTitle}</span>{/if}
                            <span class="text-xs text-gray-300">{dateFormatter.format(m.startedAt)} ~</span>
                        </div>
                        <form method="POST" action="?/removePart" use:enhance>
                            <input type="hidden" name="membershipId" value={m.id} />
                            <button type="submit" class="text-xs text-red-400 hover:text-red-600">{t("common.remove")}</button>
                        </form>
                    </div>
                {/each}
            </div>
        {:else}
            <p class="mb-4 text-sm text-gray-400">{t("user_detail.part_empty")}</p>
        {/if}

        <form method="POST" action="?/addPart" use:enhance class="grid grid-cols-2 gap-2 border-t border-gray-100 pt-4 sm:grid-cols-4">
            <select name="partId" required class="col-span-2 rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none sm:col-span-1">
                <option value="">{t("user_detail.part_select")}</option>
                {#each data.allParts as p (p.id)}
                    <option value={p.id}>{partLabel(p)}</option>
                {/each}
            </select>
            <input
                type="text"
                name="jobTitle"
                placeholder={t("user_detail.part_job_title_placeholder")}
                class="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none" />
            <div class="flex items-center gap-2">
                <label class="flex items-center gap-1 text-xs text-gray-600">
                    <input type="checkbox" name="isPrimary" value="true" class="rounded" />
                    {t("user_detail.primary")}
                </label>
                <button type="submit" class="ml-auto rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700">{t("common.add")}</button>
            </div>
        </form>
    </section>
</div>
