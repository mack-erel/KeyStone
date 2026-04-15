<script lang="ts">
  import { t } from '$lib/i18n.svelte';
</script>

<div class="flex min-h-screen items-center justify-center bg-gray-50 p-4">
  <div class="w-full max-w-[400px] rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
    <h1 class="mb-6 text-center text-2xl font-bold text-gray-900">
      {t('app.title')}
    </h1>
    
    <form method="POST" action="" class="space-y-4">
      <div>
        <label for="email" class="block text-sm font-medium text-gray-700">
          {t('login.email')}
        </label>
        <input
          type="email"
          name="email"
          id="email"
          required
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500 sm:text-sm"
        />
      </div>
      
      <div>
        <label for="password" class="block text-sm font-medium text-gray-700">
          {t('login.password')}
        </label>
        <input
          type="password"
          name="password"
          id="password"
          required
          class="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500 sm:text-sm"
        />
      </div>
      
      <button
        type="submit"
        class="flex w-full justify-center rounded-md border border-transparent bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        {t('login.submit')}
      </button>
    </form>
  </div>
</div>
