<script lang="ts">
import { enhance } from '$app/forms';
import type { ActionData, PageData } from './$types';

const { data, form } = $props<{ data: PageData; form?: ActionData }>();

const success = $derived((form as { success?: boolean } | null)?.success ?? false);
const err = $derived((form as { error?: string } | null)?.error ?? null);

const LOCALE_OPTIONS = [
	{ value: 'ko-KR', label: '한국어' },
	{ value: 'en-US', label: 'English (US)' },
	{ value: 'ja-JP', label: '日本語' },
];

const TIMEZONE_OPTIONS = [
	{ value: 'Asia/Seoul', label: 'Asia/Seoul (KST)' },
	{ value: 'Asia/Tokyo', label: 'Asia/Tokyo (JST)' },
	{ value: 'UTC', label: 'UTC' },
	{ value: 'America/New_York', label: 'America/New_York (EST)' },
];
</script>

<div class="mx-auto max-w-2xl space-y-8 p-6">
	<h1 class="text-2xl font-bold text-gray-900">내 프로필</h1>

	{#if success}
		<div class="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">프로필이 저장되었습니다.</div>
	{/if}
	{#if err}
		<div class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
			{err}
		</div>
	{/if}

	<form method="POST" use:enhance class="space-y-6">
		<!-- 기본 정보 -->
		<section class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
			<h2 class="mb-4 text-sm font-semibold text-gray-700">기본 정보</h2>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div>
					<label for="givenName" class="block text-xs font-medium text-gray-700">이름 (Given Name)</label>
					<input
						id="givenName"
						type="text"
						name="givenName"
						value={data.profile.givenName ?? ''}
						class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
				</div>
				<div>
					<label for="familyName" class="block text-xs font-medium text-gray-700">성 (Family Name)</label>
					<input
						id="familyName"
						type="text"
						name="familyName"
						value={data.profile.familyName ?? ''}
						class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
				</div>
				<div class="sm:col-span-2">
					<label for="displayName" class="block text-xs font-medium text-gray-700">표시 이름</label>
					<input
						id="displayName"
						type="text"
						name="displayName"
						value={data.profile.displayName ?? ''}
						class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
				</div>
				<div>
					<label for="birthdate" class="block text-xs font-medium text-gray-700">생년월일</label>
					<input
						id="birthdate"
						type="date"
						name="birthdate"
						value={data.profile.birthdate ?? ''}
						class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
				</div>
				<div>
					<label for="phoneNumber" class="block text-xs font-medium text-gray-700">전화번호</label>
					<input
						id="phoneNumber"
						type="tel"
						name="phoneNumber"
						value={data.profile.phoneNumber ?? ''}
						placeholder="+82-10-1234-5678"
						class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" />
				</div>
				<div class="sm:col-span-2">
					<label for="bio" class="block text-xs font-medium text-gray-700">소개</label>
					<textarea id="bio" name="bio" rows="3" class="mt-1 w-full resize-none rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
						>{data.profile.bio ?? ''}</textarea>
				</div>
			</div>
		</section>

		<!-- 지역 설정 -->
		<section class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
			<h2 class="mb-4 text-sm font-semibold text-gray-700">지역 설정</h2>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<div>
					<label for="locale" class="block text-xs font-medium text-gray-700">언어</label>
					<select id="locale" name="locale" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
						{#each LOCALE_OPTIONS as opt (opt.value)}
							<option value={opt.value} selected={data.profile.locale === opt.value}>{opt.label}</option>
						{/each}
					</select>
				</div>
				<div>
					<label for="zoneinfo" class="block text-xs font-medium text-gray-700">시간대</label>
					<select id="zoneinfo" name="zoneinfo" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none">
						{#each TIMEZONE_OPTIONS as opt (opt.value)}
							<option value={opt.value} selected={data.profile.zoneinfo === opt.value}>{opt.label}</option>
						{/each}
					</select>
				</div>
			</div>
		</section>

		<!-- 조직 소속 (읽기 전용) -->
		{#if data.membership.departments.length > 0 || data.membership.teams.length > 0 || data.membership.parts.length > 0}
			<section class="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
				<h2 class="mb-4 text-sm font-semibold text-gray-700">조직 소속</h2>
				<div class="space-y-3">
					{#each data.membership.departments as dept (dept.name)}
						<div class="flex items-center gap-3 rounded-lg bg-gray-50 px-4 py-2.5 text-sm">
							<span class="font-medium text-gray-900">{dept.name}</span>
							{#if dept.isPrimary}<span class="rounded-full bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700">주소속</span>{/if}
							{#if dept.jobTitle}<span class="text-gray-500">/ {dept.jobTitle}</span>{/if}
							{#if dept.position}<span class="text-gray-400">({dept.position.name})</span>{/if}
						</div>
					{/each}
					{#each data.membership.teams as team (team.name)}
						<div class="flex items-center gap-3 rounded-lg bg-gray-50 px-4 py-2.5 text-sm">
							<span class="text-xs text-gray-500">팀</span>
							<span class="font-medium text-gray-900">{team.name}</span>
							{#if team.departmentName}<span class="text-xs text-gray-400">({team.departmentName})</span>{/if}
							{#if team.isPrimary}<span class="rounded-full bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-700">주소속</span>{/if}
							{#if team.jobTitle}<span class="text-gray-500">/ {team.jobTitle}</span>{/if}
						</div>
					{/each}
					{#each data.membership.parts as part (part.name)}
						<div class="flex items-center gap-3 rounded-lg bg-gray-50 px-4 py-2.5 text-sm">
							<span class="text-xs text-gray-500">파트</span>
							<span class="font-medium text-gray-900">{part.name}</span>
							{#if part.teamName}<span class="text-xs text-gray-400">({part.teamName})</span>{/if}
							{#if part.isPrimary}<span class="rounded-full bg-violet-100 px-1.5 py-0.5 text-xs text-violet-700">주소속</span>{/if}
							{#if part.jobTitle}<span class="text-gray-500">/ {part.jobTitle}</span>{/if}
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<div class="flex justify-end">
			<button type="submit" class="rounded-md bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700"> 저장 </button>
		</div>
	</form>
</div>
