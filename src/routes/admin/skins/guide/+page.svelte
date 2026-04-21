<script lang="ts">
import { resolve } from "$app/paths";
import { t } from "$lib/i18n.svelte";
</script>

<div class="max-w-3xl space-y-8">
    <div class="flex items-center justify-between">
        <div>
            <h1 class="text-2xl font-bold text-gray-900">{t("skins.guide_title")}</h1>
            <p class="mt-1 text-sm text-gray-500">{t("skins.guide_subtitle")}</p>
        </div>
        <a href={resolve("/admin/skins")} class="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
            ← {t("skins.title")}
        </a>
    </div>

    <!-- 개요 -->
    <section class="space-y-3 rounded-xl border border-gray-200 bg-white p-6">
        <h2 class="text-base font-semibold text-gray-900">{t("skins.guide_overview_title")}</h2>
        <p class="text-sm leading-relaxed text-gray-600">{t("skins.guide_overview_desc")}</p>
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {#each [{ type: "login", path: "/login" }, { type: "signup", path: "/signup" }, { type: "find_id", path: "/find-id" }, { type: "find_password", path: "/find-password" }] as item (item.type)}
                <div class="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-center">
                    <p class="text-xs font-medium text-gray-700">{t(`skins.skin_type_${item.type}`)}</p>
                    <p class="mt-0.5 font-mono text-xs text-gray-400">{item.path}</p>
                </div>
            {/each}
        </div>
    </section>

    <!-- 동작 흐름 -->
    <section class="space-y-3 rounded-xl border border-gray-200 bg-white p-6">
        <h2 class="text-base font-semibold text-gray-900">{t("skins.guide_flow_title")}</h2>
        <ol class="list-inside list-decimal space-y-2 text-sm leading-relaxed text-gray-600">
            <li>{t("skins.guide_flow_1")}</li>
            <li>{t("skins.guide_flow_2")}</li>
            <li>{t("skins.guide_flow_3")}</li>
            <li>{t("skins.guide_flow_4")}</li>
            <li>{t("skins.guide_flow_5")}</li>
        </ol>
    </section>

    <!-- 치환자 -->
    <section class="space-y-4 rounded-xl border border-gray-200 bg-white p-6">
        <h2 class="text-base font-semibold text-gray-900">{t("skins.guide_placeholders_title")}</h2>
        <table class="min-w-full text-sm">
            <thead>
                <tr class="border-b border-gray-100">
                    <th class="w-56 pb-2 text-left text-xs font-medium text-gray-500 uppercase">{t("skins.guide_placeholder_col_name")}</th>
                    <th class="pb-2 text-left text-xs font-medium text-gray-500 uppercase">{t("skins.guide_placeholder_col_desc")}</th>
                </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
                {#each [{ key: "IDP_FORM_ACTION", desc: t("skins.placeholder_form_action") }, { key: "IDP_REDIRECT_TO", desc: t("skins.placeholder_redirect_to") }, { key: "IDP_SKIN_HINT", desc: t("skins.placeholder_skin_hint") }] as row (row.key)}
                    <tr>
                        <td class="py-2.5 pr-4">
                            <code class="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-blue-700">&#123;&#123;{row.key}&#125;&#125;</code>
                        </td>
                        <td class="py-2.5 text-xs text-gray-600">{row.desc}</td>
                    </tr>
                {/each}
            </tbody>
        </table>
    </section>

    <!-- X-IDP-Token -->
    <section class="space-y-3 rounded-xl border border-gray-200 bg-white p-6">
        <h2 class="text-base font-semibold text-gray-900">{t("skins.guide_auth_title")}</h2>
        <p class="text-sm leading-relaxed text-gray-600">{t("skins.guide_auth_desc")}</p>
        <div class="rounded-lg bg-gray-900 p-4">
            <pre class="overflow-x-auto text-xs text-green-400">{`// 스킨 서버에서 요청 검증 예시 (Node.js)
app.get('/login-skin.html', (req, res) => {
  const token = req.headers['x-idp-token'];
  if (token !== process.env.SKIN_SECRET) {
    return res.status(401).send('Unauthorized');
  }
  res.sendFile('./login-skin.html');
});`}</pre>
        </div>
    </section>

    <!-- 스킨 HTML 예시 -->
    <section class="space-y-3 rounded-xl border border-gray-200 bg-white p-6">
        <h2 class="text-base font-semibold text-gray-900">{t("skins.guide_example_title")}</h2>
        <p class="text-sm text-gray-500">{t("skins.guide_example_login_desc")}</p>
        <div class="rounded-lg bg-gray-900 p-4">
            <pre class="overflow-x-auto text-xs text-gray-300">{`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>로그인</title>
  <style>
    body { display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f9fafb; }
    .card { background: white; border-radius: 12px; padding: 32px;
            box-shadow: 0 1px 4px rgba(0,0,0,.08); width: 360px; }
    input { width: 100%; box-sizing: border-box; padding: 8px 12px;
            border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; margin-top: 4px; }
    button { width: 100%; padding: 10px; background: #2563eb; color: white;
             border: none; border-radius: 6px; font-size: 14px; cursor: pointer; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h1 style="font-size:20px;font-weight:700;margin:0 0 24px">로그인</h1>
    <form method="POST" action="{{IDP_FORM_ACTION}}">
      <input type="hidden" name="redirectTo" value="{{IDP_REDIRECT_TO}}">
      <input type="hidden" name="skinHint" value="{{IDP_SKIN_HINT}}">
      <div>
        <label style="font-size:12px;font-weight:500;color:#374151">아이디</label>
        <input type="text" name="username" autocomplete="username" required>
      </div>
      <div style="margin-top:12px">
        <label style="font-size:12px;font-weight:500;color:#374151">비밀번호</label>
        <input type="password" name="password" autocomplete="current-password" required>
      </div>
      <button type="submit">로그인</button>
    </form>
  </div>
</body>
</html>`}</pre>
        </div>
        <div class="space-y-1 rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            <p class="font-medium">{t("skins.guide_example_note_title")}</p>
            <ul class="list-inside list-disc space-y-0.5">
                <li>{t("skins.guide_example_note_1")}</li>
                <li>{t("skins.guide_example_note_2")}</li>
                <li>{t("skins.guide_example_note_3")}</li>
            </ul>
        </div>
    </section>

    <!-- 캐시 동작 -->
    <section class="space-y-3 rounded-xl border border-gray-200 bg-white p-6">
        <h2 class="text-base font-semibold text-gray-900">{t("skins.guide_cache_title")}</h2>
        <ul class="list-inside list-disc space-y-1.5 text-sm leading-relaxed text-gray-600">
            <li>{t("skins.guide_cache_1")}</li>
            <li>{t("skins.guide_cache_2")}</li>
            <li>{t("skins.guide_cache_3")}</li>
        </ul>
    </section>

    <!-- 등록 방법 -->
    <section class="space-y-3 rounded-xl border border-gray-200 bg-white p-6">
        <h2 class="text-base font-semibold text-gray-900">{t("skins.guide_setup_title")}</h2>
        <ol class="list-inside list-decimal space-y-2 text-sm leading-relaxed text-gray-600">
            <li>{t("skins.guide_setup_1")}</li>
            <li>{t("skins.guide_setup_2")}</li>
            <li>{t("skins.guide_setup_3")}</li>
            <li>{t("skins.guide_setup_4")}</li>
        </ol>
        <a href={resolve("/admin/skins")} class="mt-2 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            {t("skins.title")} →
        </a>
    </section>
</div>
