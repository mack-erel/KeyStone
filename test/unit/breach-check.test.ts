import { describe, it, expect, afterEach } from "vitest";
import { isPasswordBreached } from "$lib/server/auth/breach-check";

async function sha1Upper(s: string): Promise<string> {
    const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
    return [...new Uint8Array(d)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
}

const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe("isPasswordBreached (HIBP k-anonymity)", () => {
    it("prefix(5자)만 전송하고, suffix 가 count>0 로 응답되면 true", async () => {
        const pw = "hunter2";
        const hash = await sha1Upper(pw);
        const prefix = hash.slice(0, 5);
        const suffix = hash.slice(5);
        globalThis.fetch = (async (url: RequestInfo | URL) => {
            // 원문/전체 해시가 아니라 prefix 만 URL 에 담겨야 한다(k-anonymity).
            expect(String(url)).toContain(prefix);
            expect(String(url)).not.toContain(suffix);
            return new Response(`${suffix}:42\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0\r\n`, { status: 200 });
        }) as typeof globalThis.fetch;
        expect(await isPasswordBreached(pw)).toBe(true);
    });

    it("응답 목록에 suffix 가 없으면 false", async () => {
        globalThis.fetch = (async () => new Response("0123456789012345678901234567890123X:5\r\n", { status: 200 })) as typeof globalThis.fetch;
        expect(await isPasswordBreached("some-unique-password")).toBe(false);
    });

    it("count=0(패딩 항목)이면 유출로 보지 않는다", async () => {
        const suffix = (await sha1Upper("padded-pw")).slice(5);
        globalThis.fetch = (async () => new Response(`${suffix}:0\r\n`, { status: 200 })) as typeof globalThis.fetch;
        expect(await isPasswordBreached("padded-pw")).toBe(false);
    });

    it("비200 응답이면 fail-open(false)", async () => {
        globalThis.fetch = (async () => new Response("error", { status: 503 })) as typeof globalThis.fetch;
        expect(await isPasswordBreached("whatever")).toBe(false);
    });

    it("fetch 예외(네트워크 오류)면 fail-open(false)", async () => {
        globalThis.fetch = (async () => {
            throw new Error("network down");
        }) as typeof globalThis.fetch;
        expect(await isPasswordBreached("whatever")).toBe(false);
    });
});
