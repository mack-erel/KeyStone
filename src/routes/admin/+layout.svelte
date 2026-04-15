<script lang="ts">
  import { t } from '$lib/i18n';
  import { page } from '$app/state';

  const { children } = $props();

  const menuItems = [
    { href: '/admin/users', key: 'admin.users' },
    { href: '/admin/oidc-clients', key: 'admin.oidc_clients' },
    { href: '/admin/saml-sps', key: 'admin.saml_sps' },
    { href: '/admin/signing-keys', key: 'admin.signing_keys' },
    { href: '/admin/audit', key: 'admin.audit' }
  ];
</script>

<div class="flex min-h-screen bg-gray-50">
  <!-- Sidebar -->
  <aside class="w-64 border-r border-gray-200 bg-white">
    <div class="flex h-16 items-center border-b border-gray-200 px-6">
      <a href="/admin" class="text-xl font-bold text-gray-900">
        {t('admin.title')}
      </a>
    </div>
    
    <nav class="p-4">
      <ul class="space-y-1">
        {#each menuItems as item}
          <li>
            <a
              href={item.href}
              class="block rounded-md px-3 py-2 text-sm font-medium transition-colors {page.url.pathname === item.href ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-100'}"
            >
              {t(item.key)}
            </a>
          </li>
        {/each}
      </ul>
    </nav>
  </aside>

  <!-- Main content -->
  <main class="flex-1 p-8">
    {@render children()}
  </main>
</div>
