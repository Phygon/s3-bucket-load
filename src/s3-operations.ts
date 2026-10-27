import type { HttpOperation, HttpRequest } from "./http-operation.ts";
import { buildCompleteMultipartXml, encodeObjectKey, parseS3Xml, sanitizeETag } from "./s3-utils.ts";

type GetObjectOperationInput = {
    key: string;
};

type PutObjectOperationInput = {
    key: string;
    body: Blob;
    contentType?: string;
};

type PutObjectResult = {
    etag?: string;
};

type CreateMultipartUploadOperationInput = {
    key: string;
    contentType?: string;
};

type CreateMultipartUploadResult = {
    uploadId: string;
};

type UploadPartOperationInput = {
    key: string;
    uploadId: string;
    partNumber: number;
    body: Blob;
};

type UploadPartResult = {
    partNumber: number;
    etag: string;
};

type CompleteMultipartUploadPart = {
    partNumber: number;
    etag: string;
};

type CompleteMultipartUploadOperationInput = {
    key: string;
    uploadId: string;
    parts: CompleteMultipartUploadPart[];
};

type CompleteMultipartUploadResult = {
    etag?: string;
    location?: string;
};

type AbortMultipartUploadOperationInput = {
    key: string;
    uploadId: string;
};

/** Returns a Content-Type header when one is given, or no headers. */
function contentHeaders(contentType: string | undefined): Record<string, string> {
    return contentType === undefined ? {} : { 'Content-Type': contentType };
}

/** Creates a GET operation. Download progress is attached at execution time by HttpExecutor. */
export function getObjectOperation(input: GetObjectOperationInput): HttpOperation<Response> {
    return {
        progressDirection: 'download',
        buildRequest(): HttpRequest {
            return {
                path: encodeObjectKey(input.key),
                method: 'GET',
            };
        },
        parseResponse: (response) => response,
    };
}

/** Creates a PUT operation. Upload progress is attached at execution time by HttpExecutor. */
export function putObjectOperation(input: PutObjectOperationInput): HttpOperation<PutObjectResult> {
    return {
        progressDirection: 'upload',
        buildRequest(): HttpRequest {
            return {
                path: encodeObjectKey(input.key),
                method: 'PUT',
                headers: contentHeaders(input.contentType),
                body: input.body,
            };
        },
        parseResponse(response) {
            return { etag: sanitizeETag(response.headers.get('etag')) };
        },
    };
}

/** Creates an MPU. Initiation is not retried automatically to avoid orphaning duplicate upload IDs. */
export function createMultipartUploadOperation(
    input: CreateMultipartUploadOperationInput,
): HttpOperation<CreateMultipartUploadResult> {
    return {
        allowRetry: false,
        buildRequest(): HttpRequest {
            return {
                path: encodeObjectKey(input.key),
                query: { uploads: '' },
                method: 'POST',
                headers: contentHeaders(input.contentType),
            };
        },
        async parseResponse(response) {
            const { UploadId: uploadId } = parseS3Xml<{ UploadId?: string }>(
                await response.text(),
                response.status,
                response.headers,
            );
            if (!uploadId) {
                throw new Error('CreateMultipartUpload response did not contain UploadId');
            }
            return { uploadId };
        },
    };
}

/** Creates one part PUT. Retries are safe for the same upload ID and part number. */
export function uploadPartOperation(input: UploadPartOperationInput): HttpOperation<UploadPartResult> {
    return {
        progressDirection: 'upload',
        buildRequest(): HttpRequest {
            return {
                path: encodeObjectKey(input.key),
                query: { partNumber: String(input.partNumber), uploadId: input.uploadId },
                method: 'PUT',
                body: input.body,
            };
        },
        parseResponse(response) {
            const etag = sanitizeETag(response.headers.get('etag'));
            if (!etag) {
                throw new Error(`UploadPart ${input.partNumber} response did not contain ETag`);
            }
            return { partNumber: input.partNumber, etag };
        },
    };
}

/** Creates a completion request. It may be retried: an upload ID completes at most once, and a retry after a lost response can fail with NoSuchUpload. */
export function completeMultipartUploadOperation(
    input: CompleteMultipartUploadOperationInput,
): HttpOperation<CompleteMultipartUploadResult> {
    return {
        buildRequest(): HttpRequest {
            const path = encodeObjectKey(input.key);
            const body = buildCompleteMultipartXml(input.parts);
            return {
                path,
                query: { uploadId: input.uploadId },
                method: 'POST',
                headers: { 'Content-Type': 'application/xml' },
                body,
            };
        },
        async parseResponse(response) {
            const result = parseS3Xml<{ ETag?: string; Location?: string }>(
                await response.text(),
                response.status,
                response.headers,
            );
            return {
                etag: sanitizeETag(result.ETag),
                location: result.Location,
            };
        },
    };
}

/** Creates an abort request. Repeating the request is safe. */
export function abortMultipartUploadOperation(
    input: AbortMultipartUploadOperationInput,
): HttpOperation<void> {
    return {
        buildRequest(): HttpRequest {
            return { path: encodeObjectKey(input.key), query: { uploadId: input.uploadId }, method: 'DELETE' };
        },
        parseResponse: () => undefined,
    };
}
