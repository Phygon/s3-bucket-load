import { mergeHeaders, normalizeEndpoint, prepareBody, responseWithProgress } from "./http-utils.ts";
import type { HttpExecutionOptions, HttpOperation } from "./http-operation.ts";
import { retry, type RetryOptions } from "./retry.ts";
import { ServiceError, toServiceError } from "./service-error.ts";

/** The fetch used by the executor. It always receives a URL and a fully built init object. */
export type HttpFetch = (url: URL, init?: RequestInit) => Promise<Response>;

export type HttpExecutorOptions = {
    endpoint: string | URL;
    fetch?: HttpFetch;
    headers?: Record<string, string> | Headers;
    retry?: Partial<RetryOptions>;
    /** Converts a non-success response into a normalized service error. */
    parseServiceError?: (response: Response) => Promise<ServiceError>;
};

/** Executes typed HTTP operations over a configured base endpoint. */
export class HttpExecutor {
    private readonly endpoint: URL;
    private readonly fetch: HttpFetch;
    private readonly headers: Headers;
    private readonly retryOptions: Partial<RetryOptions>;
    private readonly parseServiceError: (response: Response) => Promise<ServiceError>;

    constructor(options: HttpExecutorOptions) {
        this.endpoint = normalizeEndpoint(options.endpoint);
        this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.headers = new Headers(options.headers);
        this.retryOptions = options.retry ?? {};
        this.parseServiceError = options.parseServiceError ?? defaultServiceError;
    }

    /** Executes an operation; signal and progress apply to this execution, not to the reusable operation descriptor. */
    execute<Result>(operation: HttpOperation<Result>, options: HttpExecutionOptions = {}): Promise<Result> {
        const attempt = () => this.executeRequest(operation, options);
        if (operation.allowRetry === false) {
            return attempt();
        }
        return retry(attempt, this.retryOptions, options.signal);
    }

    private async executeRequest<Result>(
        operation: HttpOperation<Result>,
        options: HttpExecutionOptions,
    ): Promise<Result> {
        const request = operation.buildRequest();
        const url = new URL(request.path, this.endpoint);
        for (const [name, value] of Object.entries(request.query ?? {})) {
            url.searchParams.set(name, value);
        }

        const preparedBody = prepareBody(request.body, operation.progressDirection, options.onProgress);
        const headers = mergeHeaders(this.headers, request.headers ?? {});
        if (preparedBody.contentLength !== undefined) {
            headers.set('content-length', String(preparedBody.contentLength));
        }

        const init: RequestInit & { duplex?: 'half' } = {
            method: request.method,
            headers,
            signal: options.signal,
            ...(preparedBody.body !== undefined && { body: preparedBody.body }),
            ...(preparedBody.duplex && { duplex: 'half' }),
        };

        const response = await this.fetch(url, init);
        if (!response.ok) {
            throw await this.parseServiceError(response);
        }

        const parsedResponse = operation.progressDirection === 'download' && options.onProgress
            ? responseWithProgress(response, options.onProgress)
            : response;
        return operation.parseResponse(parsedResponse);
    }
}

/** Default error for non-OK responses: the body text or status text as message, plus status and retry metadata. */
async function defaultServiceError(response: Response): Promise<ServiceError> {
    let body = '';
    try {
        body = await response.text();
    } catch {
        // Keep the HTTP status when the body cannot be read.
    }

    return toServiceError({
        status: response.status,
        message: body.trim() || response.statusText || `HTTP request failed with status ${response.status}`,
        requestId: response.headers.get('x-request-id') ?? undefined,
    }, response.headers);
}
