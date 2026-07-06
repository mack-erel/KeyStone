<script lang="ts">
/**
 * 공용 폼 에러 배너.
 * - role="alert" + aria-live="assertive" 로 스크린리더에 즉시 announce.
 * - 메시지가 나타나거나 바뀌면(제출 실패 후 재렌더) tabindex="-1" 요소로 포커스를 옮겨
 *   키보드/스크린리더 사용자가 에러 위치를 즉시 인지하도록 한다.
 * - 시각 스타일은 각 라우트 기존 마크업과 동일하게 유지하기 위해 `class` prop 으로 주입한다.
 */
import type { Attachment } from "svelte/attachments";

interface Props {
    message?: string | null;
    /** 배너 컨테이너 클래스. 각 라우트의 기존 스타일을 그대로 넘겨 시각 무회귀를 보장한다. */
    class?: string;
}

const { message = null, class: className = "rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" }: Props = $props();

// 요소가 마운트될 때, 그리고 message 가 바뀔 때마다 포커스를 이동한다.
// 본문에서 message 를 읽어 reactive dependency 로 등록한다(값이 바뀌면 attachment 재실행).
const focusOnError: Attachment<HTMLElement> = (node) => {
    if (message) node.focus();
};
</script>

{#if message}
    <div {@attach focusOnError} role="alert" aria-live="assertive" tabindex="-1" class="{className} outline-none">
        {message}
    </div>
{/if}
