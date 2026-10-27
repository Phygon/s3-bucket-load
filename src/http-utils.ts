import type { HttpOperation, HttpRequestBody } from "./http-operation.ts";

/** Byte-transfer progress; total is unknown when the response has no valid Content-Length. */
export type TransferProgress = {
    /** Cumulative bytes transferred so far. */
    transferred: number;
    /** Total bytes, or `undefined` when unknown. */
    total: number | undefined;
};

export type ProgressCallback = (progress: TransferProgress) => void;

/** Returns a new Headers object with `extra` applied over `base`; `undefined` values in `extra` are skipped. */
export function mergeHeaders(
    base: Record<string, string> | Headers,
    extra: Record<string, string | undefined>,
): Headers {
    const headers = new Headers(base);
    for (const [name, value] of Object.entries(extra)) {
        if (value !== undefined) {
            headers.set(name, value);
        }
    }
    return headers;
}

/** Wraps a byte stream and reports cumulative transferred bytes and the optional total. */
export function trackByteProgress(
    stream: ReadableStream<Uint8Array>,
    total?: number,
    onProgress?: ProgressCallback,
): ReadableStream<Uint8Array> {
    const reader = stream.getReader();
    let transferred = 0;

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    controller.close();
                    return;
                }

                transferred += value.byteLength;
                onProgress?.({ transferred, total });
                controller.enqueue(value);
            } catch (error) {
                // Cancel the source and preserve the original read or callback error.
                try {
                    await reader.cancel(error);
                } catch {
                    // Preserve the original error.
                }
                throw error;
            }
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}

/** Parses a Content-Length header value, returning undefined when it is missing or invalid. */
export function parseContentLength(contentLength: string | null): number | undefined {
    if (contentLength === null || !/^\d+$/.test(contentLength)) {
        return undefined;
    }

    const total = Number(contentLength);
    return Number.isSafeInteger(total) ? total : undefined;
}

/** Wraps a response body to report download progress, preserving response metadata. */
export function responseWithProgress(response: Response, onProgress: ProgressCallback): Response {
    const body = response.body;
    if (!body) {
        return response;
    }

    const total = parseContentLength(response.headers.get('content-length'));

    const progressResponse = new Response(trackByteProgress(body, total, onProgress), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });

    Object.defineProperties(progressResponse, {
        url: { value: response.url },
        type: { value: response.type },
        redirected: { value: response.redirected },
    });

    return progressResponse;
}

/** The body type accepted by fetch, derived from RequestInit. */
type FetchBody = NonNullable<RequestInit['body']>;

/** Parses an endpoint and ensures a trailing slash, so relative paths resolve under it. The endpoint must not contain a query or hash. */
export function normalizeEndpoint(endpoint: string | URL): URL {
    const url = new URL(endpoint);
    if (!url.pathname.endsWith('/')) {
        url.pathname += '/';
    }
    return url;
}

/** Wraps a body for fetch. Only uploads with progress are read as a stream, so progress can be reported. */
export function prepareBody(
    body: HttpRequestBody | undefined,
    progressDirection: HttpOperation<unknown>['progressDirection'],
    onProgress?: ProgressCallback,
): { body?: FetchBody; duplex?: boolean; contentLength?: number } {
    if (body === undefined) {
        return {};
    }

    if (progressDirection !== 'upload' || !onProgress) {
        return isReadableStream(body) ? { body, duplex: true } : { body: body as FetchBody };
    }

    if (isReadableStream(body)) {
        return { body: trackByteProgress(body, undefined, onProgress), duplex: true };
    }
    const blob = body instanceof Blob
        ? body
        : new Blob([typeof body === 'string' ? body : toBlobPart(body)]);
    return {
        body: trackByteProgress(blob.stream(), blob.size, onProgress),
        duplex: true,
        contentLength: blob.size,
    };
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
    return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream;
}

function toBlobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const buffer = bytes.buffer;
    if (buffer instanceof ArrayBuffer) {
        return new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength);
    }

    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}
