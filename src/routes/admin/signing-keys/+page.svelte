<script lang="ts">
  import { t } from '$lib/i18n';
</script>

<div class="space-y-6">
  <div class="flex items-center justify-between">
    <h1 class="text-2xl font-bold text-gray-900">{t('admin.signing_keys')}</h1>
  </div>

  <div class="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
    <table class="min-w-full divide-y divide-gray-200">
      <thead class="bg-gray-50">
        <tr>
          <th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
            Kid
          </th>
          <th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
            Algorithm
          </th>
          <th class="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
            Created At
          </th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-200 bg-white">
        <!-- Empty -->
      </tbody>
    </table>
  </div>
</div>
