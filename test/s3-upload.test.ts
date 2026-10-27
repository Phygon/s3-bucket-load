import { describe, expect, it, vi } from 'vitest';
import { HttpExecutor } from '../src/http-executor.ts';
import type { HttpExecutionOptions, HttpOperation } from '../src/http-operation.ts';
import { S3ObjectUpload } from '../src/s3-upload.ts';

function makeExecutor(
    implementation: (operation: HttpOperation<unknown>, options?: HttpExecutionOptions) => Promise<unknown>,
) {
    const execute = vi.fn(async <Result>(operation: HttpOperation<Result>, options?: HttpExecutionOptions) =>
        await implementation(operation as HttpOperation<unknown>, options) as Result);
    return { execute, executor: { execute } as unknown as HttpExecutor };
}

function requestOf(operation: HttpOperation<unknown>) {
    return operation.buildRequest();
}

describe('S3ObjectUpload', () => {
    it('uses single PUT below the configured threshold and returns the result', async () => {
        const { execute, executor } = makeExecutor(async () => ({ etag: 'etag-1' }));
        const upload = new S3ObjectUpload({ key: 'small', source: new Blob(['abc']), executor });

        await expect(upload.start()).resolves.toMatchObject({ mode: 'single', size: 3, etag: 'etag-1' });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(upload.state).toBe('completed');
    });

    it('reports the expected single-upload state transitions', async () => {
        const onState = vi.fn();
        const { executor } = makeExecutor(async () => ({ etag: 'tag' }));
        const upload = new S3ObjectUpload({
            key: 'small', source: new Blob(['x']), executor, options: { onState },
        });
        await upload.start();
        expect(onState.mock.calls.map(([state]) => state)).toEqual(['uploading', 'completed']);
    });

    it('uploads parts and completes a multipart upload', async () => {
        const operations: HttpOperation<unknown>[] = [];
        const { executor } = makeExecutor(async (operation) => {
            operations.push(operation);
            const request = requestOf(operation);
            if (request.query?.uploads === '') return { uploadId: 'u-1' };
            if (request.query?.partNumber) {
                return { partNumber: Number(request.query.partNumber), etag: `etag-${request.query.partNumber}` };
            }
            if (request.method === 'POST' && request.query?.uploadId) return { etag: 'complete-tag' };
            if (request.method === 'DELETE') return undefined;
            throw new Error(`Unexpected request: ${request.method}`);
        });
        const onProgress = vi.fn();
        const onState = vi.fn();
        const upload = new S3ObjectUpload({
            key: 'large',
            source: new Blob(['abcde']),
            executor,
            options: {
                singleUploadThreshold: 0,
                partSize: 2,
                minPartSize: 1,
                concurrency: 2,
                onProgress,
                onState,
            },
        });

        await expect(upload.start()).resolves.toMatchObject({
            mode: 'multipart', size: 5, etag: 'complete-tag',
        });
        const partRequests = operations.map(requestOf).filter((request) => request.query?.partNumber);
        expect(partRequests).toHaveLength(3);
        expect(partRequests.map((request) => (request.body as Blob).size).sort()).toEqual([1, 2, 2]);
        expect(onProgress).toHaveBeenLastCalledWith({
            transferred: 5, total: 5, completedParts: 3, totalParts: 3,
        });
        expect(onState.mock.calls.map(([state]) => state)).toEqual([
            'uploading', 'completing', 'completed',
        ]);
    });

    it('aborts a multipart upload after a part fails and preserves the original error', async () => {
        const failure = new Error('part failed');
        const requests: Array<{ method: string; query?: Record<string, string> }> = [];
        const { executor } = makeExecutor(async (operation) => {
            const request = requestOf(operation);
            requests.push(request);
            if (request.query?.uploads === '') return { uploadId: 'u-1' };
            if (request.query?.partNumber) throw failure;
            if (request.method === 'DELETE') return undefined;
            throw new Error('Unexpected request');
        });
        const upload = new S3ObjectUpload({
            key: 'large', source: new Blob(['x']), executor,
            options: { singleUploadThreshold: 0, partSize: 1, minPartSize: 1 },
        });

        await expect(upload.start()).rejects.toBe(failure);
        expect(requests.some((request) => request.method === 'DELETE')).toBe(true);
        expect(upload.state).toBe('failed');
    });

    it('rejects invalid numeric options', () => {
        const { executor } = makeExecutor(async () => ({}));
        expect(() => new S3ObjectUpload({
            key: 'x', source: new Blob(['x']), executor, options: { partSize: 0 },
        })).toThrow(RangeError);
    });

    it('can only be started once', async () => {
        const { executor } = makeExecutor(async () => ({ etag: 'tag' }));
        const upload = new S3ObjectUpload({ key: 'x', source: new Blob(['x']), executor });
        await upload.start();
        await expect(upload.start()).rejects.toThrow('already started');
    });

    it('moves to cancelled when its signal is already aborted', async () => {
        const controller = new AbortController();
        const reason = new Error('cancelled');
        controller.abort(reason);
        const onState = vi.fn();
        const { executor } = makeExecutor(async () => ({}));
        const upload = new S3ObjectUpload({
            key: 'x', source: new Blob(['x']), executor,
            options: { signal: controller.signal, onState },
        });

        await expect(upload.start()).rejects.toBe(reason);
        expect(upload.state).toBe('cancelled');
        expect(onState).toHaveBeenCalledWith('cancelled');
    });
});
