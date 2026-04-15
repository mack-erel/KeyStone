<script lang="ts">
  import { t } from '$lib/i18n';
</script>

<div class="space-y-6">
  <h1 class="text-2xl font-bold text-gray-900">{t('admin.title')}</h1>
  
  <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
    <!-- 대시보드 요약 카드 자리 -->
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h3 class="text-sm font-medium text-gray-500">{t('admin.users')}</h3>
      <p class="mt-2 text-3xl font-bold text-gray-900">0</p>
    </div>
    
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h3 class="text-sm font-medium text-gray-500">{t('admin.oidc_clients')}</h3>
      <p class="mt-2 text-3xl font-bold text-gray-900">0</p>
    </div>
    
    <div class="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h3 class="text-sm font-medium text-gray-500">{t('admin.saml_sps')}</h3>
      <p class="mt-2 text-3xl font-bold text-gray-900">0</p>
    </div>
  </div>
</div>
