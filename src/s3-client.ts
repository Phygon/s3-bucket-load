import { HttpExecutor, type HttpFetch } from "./http-executor.ts";
import type { RetryOptions } from "./retry.ts";
import {
    S3ObjectUpload,
    type UploadOptions,
    type UploadResult,
} from "./s3-upload.ts";
import { getObjectOperation } from "./s3-operations.ts";
import { bucketEndpoint, encodeObjectKey, parseS3ServiceError } from "./s3-utils.ts";
import type { ProgressCallback } from "./http-utils.ts";
import type { Credentials, HttpMethod, Signer, SignerConfig, SignOptions } from "./signer.ts";

/** Reject key segments that URL resolution would silently normalize. */
function validateObjectKey(key: string): void {
    const invalidSegment = key.split('/').find((segment) => segment === '.' || segment === '..');
    if (invalidSegment !== undefined) {
        throw new TypeError(`Object keys cannot contain "${invalidSegment}" as a path segment`);
    }
}

/** Options for one object download. */
export type DownloadOptions = {
    /** Cancels the request and response-body consumption. */
    signal?: AbortSignal;
    /** Reports bytes as the response body is consumed; `total` may be unknown. */
    onProgress?: ProgressCallback;
};

/** Configuration for a client bound to one bucket. */
export type ClientConfig = {
    /** Name of the bucket the client will access. */
    bucket: string;
    /** Credentials passed to the signer. A local AWS signer also needs `secretAccessKey`. */
    credentials?: Credentials;

    /** Defaults to "auto" when `endpoint` is set; required otherwise. */
    region?: string;
    /** Custom endpoint for S3-compatible services; URLs are then path-style. */
    endpoint?: string;

    /** Fetch implementation used to send requests. */
    fetch?: typeof fetch;
    /** Signs each request before it is sent. */
    signer: Signer;
    /** Overrides retry behavior for retryable requests. */
    retry?: Partial<RetryOptions>;
};

/**
 * S3 client bound to one bucket, with signed requests, retries, and single or multipart transfers.
 *
 * @example
 * ```ts
 * import { createAwsSigner, S3Client } from 's3-bucket-load';
 *
 * const client = new S3Client({
 *   bucket: 'archive',
 *   region: 'eu-west-1',
 *   credentials: {
 *     accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
 *     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
 *   },
 *   signer: createAwsSigner(),
 * });
 * const response = await client.download('reports/latest.csv');
 * ```
 */
export class S3Client {
    private readonly signerConfig: SignerConfig;
    private readonly signer: Signer;
    private readonly fetch: typeof fetch;
    private readonly resolvedEndpoint: string;
    private readonly executor: HttpExecutor;

    /** The bucket this client is configured to access. */
    get bucket(): string {
        return this.signerConfig.bucket;
    }

    /** The resolved signing region, including `auto` for an endpoint without an explicit region. */
    get region(): string {
        return this.signerConfig.region;
    }

    /** The resolved bucket endpoint used for requests. */
    get endpoint(): string {
        return this.resolvedEndpoint;
    }

    /**
     * Creates a client for `config.bucket`.
     * AWS endpoints require `region`; with a custom endpoint, region defaults to `auto` and requests use path-style URLs.
     * Supply a signer such as `createAwsSigner()` or a provider-backed AWS signer.
     * @throws {TypeError} If neither `region` nor a custom `endpoint` is supplied.
     */
    constructor(config: ClientConfig) {
        if (!config.endpoint && !config.region) {
            throw new TypeError('S3Client needs a region when no endpoint is set');
        }

        this.signerConfig = {
            bucket: config.bucket,
            region: config.region ?? 'auto',
            credentials: config.credentials,
        };
        this.signer = config.signer;
        this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
        this.resolvedEndpoint = bucketEndpoint({
            bucket: this.signerConfig.bucket,
            region: this.signerConfig.region,
            endpoint: config.endpoint,
        });
        this.executor = new HttpExecutor({
            endpoint: this.endpoint,
            fetch: this.createSignedFetch(),
            retry: config.retry,
            parseServiceError: parseS3ServiceError,
        });
    }

    /**
     * Uploads a `Blob` under `key`, using one PUT up to `singleUploadThreshold` and multipart above it.
     * Keys cannot contain `.` or `..` as complete slash-delimited segments.
     * @throws {TypeError} Rejects the promise if the key contains a `.` or `..` segment.
     * @throws {RangeError} Rejects the promise if a numeric upload option is invalid.
     *
     * @example
     * ```ts
     * import { openAsBlob } from 'node:fs';
     *
     * const video = await openAsBlob('./input.mp4', { type: 'video/mp4' });
     * const result = await client.upload('videos/input.mp4', video, {
     *   onProgress: ({ transferred, total }) => console.log(`${transferred} / ${total ?? '?'} bytes`),
     * });
     * ```
     */
    async upload(key: string, source: Blob, options: UploadOptions = {}): Promise<UploadResult> {
        validateObjectKey(key);
        return new S3ObjectUpload({ key, source, executor: this.executor, options }).start();
    }

    /**
     * Downloads `key` and returns a `Response`; consume its body to read the object.
     * When progress is requested, the response body is wrapped to report bytes as it is consumed.
     * Keys cannot contain `.` or `..` as complete slash-delimited segments.
     * @throws {TypeError} Rejects the promise if the key contains a `.` or `..` segment.
     *
     * @example
     * ```ts
     * const response = await client.download('reports/today.csv', {
     *   onProgress: ({ transferred, total }) => console.log(transferred, total),
     * });
     * const csv = await response.text();
     * ```
     */
    async download(key: string, options: DownloadOptions = {}): Promise<Response> {
        validateObjectKey(key);
        return this.executor.execute(getObjectOperation({ key }), options);
    }

    /**
     * Returns a presigned GET URL for `key` without making a request to S3; the signer may make a network request.
     * Keys cannot contain `.` or `..` as complete slash-delimited segments.
     * @throws {TypeError} Rejects the promise if the key contains a `.` or `..` segment.
     */
    async getDownloadUrl(key: string, options: Omit<SignOptions, 'signQuery'> = {}): Promise<string> {
        validateObjectKey(key);
        const { url } = await this.signer(
            { ...options, url: new URL(encodeObjectKey(key), this.endpoint).href, method: 'GET', signQuery: true },
            this.signerConfig,
        );
        return url;
    }

    /** Signs each executor request immediately before sending it with fetch. */
    private createSignedFetch(): HttpFetch {
        return async (url, init = {}) => {
            const method = (init.method ?? 'GET') as HttpMethod;
            const headers = new Headers(init.headers);
            headers.set('x-amz-content-sha256', 'UNSIGNED-PAYLOAD');

            const signed = await this.signer({ url: url.href, method, headers }, this.signerConfig);
            return this.fetch(signed.url, { ...init, method, headers: signed.headers });
        };
    }
}
