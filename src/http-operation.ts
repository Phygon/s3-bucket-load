import type { ProgressCallback } from "./http-utils.ts";

export type HttpRequestBody = Blob | string | Uint8Array | ReadableStream<Uint8Array>;

/** One HTTP request description, relative to the executor's endpoint. `path` must already be encoded. */
export type HttpRequest = {
    path: string;
    query?: Record<string, string>;
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';
    headers?: Record<string, string>;
    body?: HttpRequestBody;
};

export type ProgressDirection = 'upload' | 'download';

/** A typed HTTP operation. Keep per-execution controls such as signal and progress out of this descriptor. */
export type HttpOperation<Result> = {
    /** Selects which stream the executor instruments when `onProgress` is supplied. */
    progressDirection?: ProgressDirection;
    /** Set to false when a repeated request could duplicate a side effect. Defaults to true. */
    allowRetry?: boolean;
    /** Called for every retry attempt; return a fresh request body stream when one is needed. */
    buildRequest(): HttpRequest;
    /** Parses a successful response. For download operations, the response body is progress-wrapped first. */
    parseResponse(response: Response): Promise<Result> | Result;
};

/** Controls for one execution of an operation; a descriptor can be reused with different controls. */
export type HttpExecutionOptions = {
    signal?: AbortSignal;
    onProgress?: ProgressCallback;
};
