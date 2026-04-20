<script lang="ts">
import { onMount } from "svelte";
import { enhance } from "$app/forms";
import { t } from "$lib/i18n.svelte";

let formEl: HTMLFormElement;
onMount(() => formEl.requestSubmit());
</script>

<form method="POST" bind:this={formEl} use:enhance>
    <p>{t("logout.in_progress")}</p>
</form>
