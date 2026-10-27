import { ServiceError } from "./service-error.ts";

/** Controls how often and how long a failed operation is retried. */
export type RetryOptions = {
    /** Maximum number of retries after the first attempt. */
    limit: number;
    /** Upper bound of the random wait before the first retry, in milliseconds; doubles with each retry. */
    baseDelay: number;
    /** Upper bound of the exponential backoff, in milliseconds. A Retry-After header can still exceed it. */
    backoffLimit: number;
    /** Longest Retry-After, in milliseconds, that is waited for; a longer one fails the operation instead. */
    maxRetryAfter: number;
};

const DEFAULT_RETRY_LIMIT = 2;
const DEFAULT_RETRY_BASE_DELAY = 500;
const DEFAULT_RETRY_BACKOFF_LIMIT = Infinity;
const DEFAULT_MAX_RETRY_AFTER = Infinity;

/** Repeats an operation for retryable failures, using exponential backoff with jitter. Unset options fall back to the defaults. */
export async function retry<T>(
    operation: () => Promise<T>,
    options: Partial<RetryOptions>,
    signal?: AbortSignal,
): Promise<T> {
    const {
        limit = DEFAULT_RETRY_LIMIT,
        baseDelay = DEFAULT_RETRY_BASE_DELAY,
        backoffLimit = DEFAULT_RETRY_BACKOFF_LIMIT,
        maxRetryAfter = DEFAULT_MAX_RETRY_AFTER,
    } = options;

    for (let retries = 0; ; retries++) {
        try {
            return await operation();
        } catch (error) {
            const retryAfter = error instanceof ServiceError ? error.retryAfter : undefined;
            const canRetry = retries < limit
                && !signal?.aborted
                && isRetryableError(error)
                && (retryAfter ?? 0) <= maxRetryAfter;
            if (!canRetry) {
                throw error;
            }

            await sleep(backoffDelay(retries, { baseDelay, backoffLimit }, retryAfter), signal);
        }
    }
}

const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;

/** Returns the service retry decision for ServiceError, or true for any other TypeError. */
export function isRetryableError(error: unknown): boolean {
    if (error instanceof ServiceError) {
        if (error.retryable !== undefined) {
            return error.retryable;
        }
        return error.status === HTTP_REQUEST_TIMEOUT
            || error.status === HTTP_TOO_MANY_REQUESTS
            || error.status >= 500;
    }
    return error instanceof TypeError;
}

/** Returns the wait before retry `attempt` (0-based): exponential with full jitter, capped at `backoffLimit`, and at least `retryAfter`. */
export function backoffDelay(
    attempt: number,
    options: { baseDelay: number; backoffLimit: number },
    retryAfter = 0,
): number {
    const ceiling = Math.min(options.backoffLimit, options.baseDelay * 2 ** attempt);
    return Math.max(retryAfter, Math.random() * ceiling);
}

/** Resolves after `ms` milliseconds, or rejects with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
