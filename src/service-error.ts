type ServiceErrorInit = {
    status: number;
    message: string;
    code?: string;
    requestId?: string;
    retryAfter?: number;
    retryable?: boolean;
};

/** A normalized error returned by a remote service over HTTP. */
export class ServiceError extends Error {
    override readonly name = 'ServiceError';
    /** HTTP status returned by the service. */
    readonly status: number;
    /** Service-specific error code, when present. */
    readonly code: string | undefined;
    /** Service request identifier, when present. */
    readonly requestId: string | undefined;
    /** Milliseconds from Retry-After, if the service sent one. */
    readonly retryAfter: number | undefined;
    /** Allows a service-specific decoder to override the executor's status-based retry rule. */
    readonly retryable: boolean | undefined;

    constructor(init: ServiceErrorInit) {
        super(init.message);
        this.status = init.status;
        this.code = init.code;
        this.requestId = init.requestId;
        this.retryAfter = init.retryAfter;
        this.retryable = init.retryable;
    }
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds relative to `now`. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
    if (!value) {
        return undefined;
    }

    const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    return Number.isNaN(delay) ? undefined : Math.max(0, delay);
}

/** Builds a ServiceError from decoded service details and shared HTTP metadata. */
export function toServiceError(
    init: Omit<ServiceErrorInit, 'retryAfter'>,
    headers: Headers,
): ServiceError {
    return new ServiceError({
        ...init,
        retryAfter: parseRetryAfter(headers.get('retry-after'), Date.now()),
    });
}
