/**
 * 스킨 캐시 스토리지 추상화.
 *
 * 우선순위:
 *   1. Cloudflare R2 바인딩(platform.env.SKIN_CACHE) 이 있으면 R2 사용.
 *   2. 없고 S3 호환 설정(S3_ENDPOINT/S3_BUCKET/키)이 있으면 S3 호환 스토리지 사용
 *      (AWS S3, MinIO, Ceph, 또는 R2 의 S3 endpoint 등). aws4fetch 로 서명하며
 *      Workers/Node 양쪽에서 동작.
 *   3. 둘 다 없으면 null — 호출부가 캐시 없이 원본 fetch 로 폴백(graceful).
 *
 * 캐시 항목은 HTML 문자열이며, TTL 판정을 위해 fetchedAt(ms) 메타데이터를 함께 저장한다
 * (R2: customMetadata, S3: x-amz-meta-fetchedat).
 */
import { AwsClient } from "aws4fetch";

export interface SkinCacheEntry {
    text(): Promise<string>;
    /** 캐시에 저장된 시각 (epoch ms). 없으면 0. */
    fetchedAt: number;
}

export interface SkinCacheStore {
    get(key: string): Promise<SkinCacheEntry | null>;
    put(key: string, value: string, fetchedAt: number): Promise<void>;
    delete(key: string): Promise<void>;
}

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const FETCHED_AT_META = "fetchedat"; // S3 메타 키는 소문자로 정규화됨

function readEnv(platform: App.Platform | undefined, key: string): string | undefined {
    const fromPlatform = (platform?.env as Record<string, unknown> | undefined)?.[key];
    if (typeof fromPlatform === "string" && fromPlatform.length > 0) return fromPlatform;
    const fromNode = typeof process !== "undefined" ? process.env?.[key] : undefined;
    return fromNode && fromNode.length > 0 ? fromNode : undefined;
}

// ── R2 바인딩 백엔드 ──────────────────────────────────────────────────────────
class R2Store implements SkinCacheStore {
    constructor(private readonly bucket: R2Bucket) {}

    async get(key: string): Promise<SkinCacheEntry | null> {
        const obj = await this.bucket.get(key);
        if (!obj) return null;
        return { text: () => obj.text(), fetchedAt: Number(obj.customMetadata?.fetchedAt ?? 0) };
    }

    async put(key: string, value: string, fetchedAt: number): Promise<void> {
        await this.bucket.put(key, value, {
            customMetadata: { fetchedAt: String(fetchedAt) },
            httpMetadata: { contentType: HTML_CONTENT_TYPE },
        });
    }

    async delete(key: string): Promise<void> {
        await this.bucket.delete(key);
    }
}

// ── S3 호환 백엔드 (aws4fetch) ────────────────────────────────────────────────
interface S3Config {
    endpoint: string; // 예: https://s3.us-east-1.amazonaws.com, http://minio:9000
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
}

class S3Store implements SkinCacheStore {
    private readonly client: AwsClient;

    constructor(private readonly cfg: S3Config) {
        this.client = new AwsClient({
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey,
            region: cfg.region,
            service: "s3",
        });
    }

    private objectUrl(key: string): string {
        const encodedKey = key
            .split("/")
            .map((seg) => encodeURIComponent(seg))
            .join("/");
        const base = this.cfg.endpoint.replace(/\/+$/, "");
        if (this.cfg.forcePathStyle) {
            return `${base}/${this.cfg.bucket}/${encodedKey}`;
        }
        // virtual-host style: https://<bucket>.<host>/<key>
        const u = new URL(base);
        u.hostname = `${this.cfg.bucket}.${u.hostname}`;
        return `${u.origin}/${encodedKey}`;
    }

    async get(key: string): Promise<SkinCacheEntry | null> {
        const res = await this.client.fetch(this.objectUrl(key), { method: "GET" });
        if (res.status === 404) return null;
        if (!res.ok) return null;
        const fetchedAt = Number(res.headers.get(`x-amz-meta-${FETCHED_AT_META}`) ?? 0);
        const body = await res.text();
        return { text: async () => body, fetchedAt };
    }

    async put(key: string, value: string, fetchedAt: number): Promise<void> {
        await this.client.fetch(this.objectUrl(key), {
            method: "PUT",
            body: value,
            headers: {
                "Content-Type": HTML_CONTENT_TYPE,
                [`x-amz-meta-${FETCHED_AT_META}`]: String(fetchedAt),
            },
        });
    }

    async delete(key: string): Promise<void> {
        await this.client.fetch(this.objectUrl(key), { method: "DELETE" });
    }
}

function getS3Config(platform: App.Platform | undefined): S3Config | null {
    const endpoint = readEnv(platform, "S3_ENDPOINT");
    const bucket = readEnv(platform, "S3_BUCKET");
    const accessKeyId = readEnv(platform, "S3_ACCESS_KEY_ID");
    const secretAccessKey = readEnv(platform, "S3_SECRET_ACCESS_KEY");
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
    const forcePathStyle = (readEnv(platform, "S3_FORCE_PATH_STYLE") ?? "true").toLowerCase() !== "false";
    return {
        endpoint,
        bucket,
        region: readEnv(platform, "S3_REGION") ?? "auto",
        accessKeyId,
        secretAccessKey,
        forcePathStyle,
    };
}

/**
 * 활성 환경에 맞는 스킨 캐시 스토어를 반환한다. 캐시를 쓸 수 없으면 null.
 */
export function getSkinCacheStore(platform: App.Platform | undefined): SkinCacheStore | null {
    const r2 = (platform?.env as Record<string, unknown> | undefined)?.SKIN_CACHE as R2Bucket | undefined;
    if (r2) return new R2Store(r2);

    const s3 = getS3Config(platform);
    if (s3) return new S3Store(s3);

    return null;
}
