import { describe, expect, it } from 'vitest';
import {
    abortMultipartUploadOperation,
    completeMultipartUploadOperation,
    createMultipartUploadOperation,
    getObjectOperation,
    putObjectOperation,
    uploadPartOperation,
} from '../src/s3-operations.ts';
import { ServiceError } from '../src/service-error.ts';

describe('S3 operation request builders', () => {
    it('builds a GET object request with an encoded key and download progress direction', () => {
        const operation = getObjectOperation({ key: 'folder/a b' });
        expect(operation.progressDirection).toBe('download');
        expect(operation.buildRequest()).toMatchObject({ path: 'folder/a%20b', method: 'GET' });
    });

    it('builds a PUT object request with its body and optional content type', () => {
        const body = new Blob(['payload']);
        const operation = putObjectOperation({ key: 'item', body, contentType: 'text/plain' });
        expect(operation.progressDirection).toBe('upload');
        expect(operation.buildRequest()).toMatchObject({
            path: 'item',
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain' },
            body,
        });
    });

    it('parses a PUT ETag', () => {
        const operation = putObjectOperation({ key: 'item', body: new Blob(['x']) });
        expect(operation.parseResponse(new Response(null, { headers: { etag: '"tag"' } })))
            .toEqual({ etag: 'tag' });
    });

    it('makes multipart initiation a non-retryable POST and parses UploadId', async () => {
        const operation = createMultipartUploadOperation({ key: 'item', contentType: 'text/plain' });
        expect(operation.allowRetry).toBe(false);
        expect(operation.buildRequest()).toMatchObject({
            path: 'item',
            query: { uploads: '' },
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
        });
        await expect(operation.parseResponse(new Response(
            '<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>',
        ))).resolves.toEqual({ uploadId: 'upload-1' });
    });

    it('rejects multipart initiation when UploadId is absent', async () => {
        const operation = createMultipartUploadOperation({ key: 'item' });
        await expect(operation.parseResponse(new Response('<Result/>')))
            .rejects.toThrow('did not contain UploadId');
    });

    it('builds a retryable part PUT and parses its ETag', () => {
        const body = new Blob(['part']);
        const operation = uploadPartOperation({ key: 'item', uploadId: 'u1', partNumber: 2, body });
        expect(operation.buildRequest()).toMatchObject({
            path: 'item',
            query: { partNumber: '2', uploadId: 'u1' },
            method: 'PUT',
            body,
        });
        expect(operation.allowRetry).not.toBe(false);
        expect(operation.parseResponse(new Response(null, { headers: { etag: '"part-tag"' } })))
            .toEqual({ partNumber: 2, etag: 'part-tag' });
    });

    it('rejects an UploadPart response without an ETag', () => {
        const operation = uploadPartOperation({ key: 'item', uploadId: 'u1', partNumber: 1, body: new Blob(['x']) });
        expect(() => operation.parseResponse(new Response(null))).toThrow('did not contain ETag');
    });

    it('builds a multipart completion request and parses its result', async () => {
        const operation = completeMultipartUploadOperation({
            key: 'item',
            uploadId: 'u1',
            parts: [{ partNumber: 1, etag: 'tag-1' }],
        });
        const request = operation.buildRequest();
        expect(request).toMatchObject({
            path: 'item',
            query: { uploadId: 'u1' },
            method: 'POST',
            headers: { 'Content-Type': 'application/xml' },
        });
        expect(request.body).toContain('<CompleteMultipartUpload>');
        await expect(operation.parseResponse(new Response(
            '<CompleteMultipartUploadResult><ETag>&quot;done&quot;</ETag><Location>/item</Location></CompleteMultipartUploadResult>',
        ))).resolves.toEqual({ etag: 'done', location: '/item' });
    });

    it('builds an abort DELETE and parses an empty success response', () => {
        const operation = abortMultipartUploadOperation({ key: 'item', uploadId: 'u1' });
        expect(operation.buildRequest()).toMatchObject({
            path: 'item',
            query: { uploadId: 'u1' },
            method: 'DELETE',
        });
        expect(operation.parseResponse(new Response(null))).toBeUndefined();
    });

    it('preserves S3 service errors while parsing XML responses', async () => {
        const operation = createMultipartUploadOperation({ key: 'item' });
        await expect(operation.parseResponse(new Response(
            '<Error><Code>AccessDenied</Code><Message>denied</Message></Error>',
            { status: 403 },
        ))).rejects.toBeInstanceOf(ServiceError);
    });
});
