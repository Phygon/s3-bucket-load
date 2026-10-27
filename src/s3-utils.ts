import { ServiceError, toServiceError } from "./service-error.ts";
import { buildXml, parseXml } from "./xml.ts";

type S3ErrorBody = {
    Code?: string;
    Message?: string;
    RequestId?: string;
};

const RETRYABLE_S3_CODES = new Set(['InternalError', 'RequestTimeout', 'ServiceUnavailable', 'SlowDown']);

/** Encodes each key segment and keeps the slashes. A leading slash becomes "./" + "/..." so it resolves under the endpoint path instead of the origin root. */
export function encodeObjectKey(key: string): string {
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return encoded.startsWith('/') ? `./${encoded}` : encoded;
}

/** Removes the surrounding double quotes from an ETag header value. */
export function sanitizeETag(etag: string | null | undefined): string | undefined {
    return etag?.replace(/^\"+|\"+$/g, '');
}

/** Returns the bucket URL used as the executor endpoint: virtual-hosted on AWS, path-style with a custom endpoint. */
export function bucketEndpoint(options: { bucket: string; endpoint?: string; region: string }): string {
    const { bucket, endpoint, region } = options;
    if (!endpoint) {
        return `https://${bucket}.s3.${region}.amazonaws.com/`;
    }

    const base = new URL(endpoint);
    base.search = '';
    base.hash = '';
    const prefix = base.href.replace(/\/+$/, '');
    return `${prefix}/${encodeURIComponent(bucket)}/`;
}

type CompletedPart = {
    partNumber: number;
    etag: string;
};

/** Builds the CompleteMultipartUpload XML body. Parts are sorted by part number. */
export function buildCompleteMultipartXml(parts: readonly CompletedPart[]): string {
    return buildXml({
        CompleteMultipartUpload: {
            Part: [...parts]
                .sort((left, right) => left.partNumber - right.partNumber)
                .map(({ partNumber, etag }) => ({
                    PartNumber: partNumber,
                    ETag: `"${etag}"`,
                })),
        },
    });
}

/** Builds a ServiceError from an S3 error response's status, headers, and XML body text. */
export function s3ServiceError(status: number, headers: Headers, body: string): ServiceError {
    let error: S3ErrorBody | undefined;
    try {
        const parsed = parseXml<S3ErrorBody>(body);
        if (parsed.rootName === 'Error') {
            error = parsed.value;
        }
    } catch {
        // A malformed or empty body still leaves the HTTP status as the error.
    }

    const code = error?.Code;
    // Undefined lets isRetryableError decide from the HTTP status.
    const retryable = code !== undefined && RETRYABLE_S3_CODES.has(code) ? true : undefined;

    return toServiceError({
        status,
        message: error?.Message ?? code ?? `S3 request failed with status ${status}`,
        code,
        requestId: error?.RequestId ?? headers.get('x-amz-request-id') ?? undefined,
        retryable,
    }, headers);
}

/** Parses an S3 XML response and returns its root value. Throws the S3 error for <Error> and when the body is empty. */
export function parseS3Xml<T>(body: string, status: number, headers: Headers): T {
    const parsed = parseXml<T>(body);
    if (parsed.rootName === 'Error') {
        throw s3ServiceError(status, headers, body);
    }
    if (parsed.value === undefined) {
        throw new Error(`S3 response with status ${status} was empty`);
    }
    return parsed.value;
}

/** Reads an S3 error response and converts it to a ServiceError. Used as the executor's parseServiceError. */
export async function parseS3ServiceError(response: Response): Promise<ServiceError> {
    let body = '';
    try {
        body = await response.text();
    } catch {
        // Keep the HTTP status when the body cannot be read.
    }
    return s3ServiceError(response.status, response.headers, body);
}
