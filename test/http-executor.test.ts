import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpExecutor, type HttpFetch } from '../src/http-executor.ts';
import type { HttpOperation } from '../src/http-operation.ts';
import { ServiceError } from '../src/service-error.ts';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function responseOperation<Result>(
    path: string,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
    parseResponse: (response: Response) => Promise<Result> | Result,
    allowRetry?: boolean,
    progressDirection?: 'upload' | 'download',
): HttpOperation<Result> {
    return {
        allowRetry,
        progressDirection,
        buildRequest: () => ({ path, method, headers: {}, body: undefined }),
        parseResponse,
    } as HttpOperation<Result>;
}

describe('HttpExecutor', () => {
    it('resolves paths and query parameters and merges headers', async () => {
        const fetch = vi.fn(async (_url: URL, _init?: RequestInit) => new Response('ok'));
        const executor = new HttpExecutor({
            endpoint: 'https://example.test/base',
            headers: { 'x-base': '1', 'x-shared': 'base' },
            fetch: fetch as unknown as HttpFetch,
            retry: { limit: 0 },
        });
        const operation: HttpOperation<string> = {
            buildRequest: () => ({
                path: 'folder/a%20b',
                query: { versionId: 'v 1' },
                method: 'GET',
                headers: { 'x-shared': 'operation' },
            }),
            parseResponse: (response) => response.text(),
        };

        await expect(executor.execute(operation)).resolves.toBe('ok');
        const [url, init] = fetch.mock.calls[0]!;
        expect(url.href).toBe('https://example.test/base/folder/a%20b?versionId=v+1');
        const headers = new Headers(init?.headers);
        expect(headers.get('x-base')).toBe('1');
        expect(headers.get('x-shared')).toBe('operation');
    });

    it('uses the default ServiceError parser for failed responses', async () => {
        const fetch = vi.fn(async () => new Response('denied', {
            status: 403,
            headers: { 'x-request-id': 'r-1' },
        })) as unknown as HttpFetch;
        const executor = new HttpExecutor({ endpoint: 'https://example.test/', fetch, retry: { limit: 0 } });
        const operation = responseOperation('object', 'GET', (response) => response.text());

        await expect(executor.execute(operation)).rejects.toMatchObject({
            name: 'ServiceError',
            status: 403,
            message: 'denied',
            requestId: 'r-1',
        });
    });

    it('uses a caller-supplied error parser', async () => {
        const fetch = vi.fn(async () => new Response('ignored', { status: 400 })) as unknown as HttpFetch;
        const custom = new ServiceError({ status: 400, message: 'custom failure', code: 'Custom' });
        const parseServiceError = vi.fn(async () => custom);
        const executor = new HttpExecutor({
            endpoint: 'https://example.test/',
            fetch,
            parseServiceError,
            retry: { limit: 0 },
        });

        await expect(executor.execute(responseOperation('object', 'GET', (response) => response.text())))
            .rejects.toBe(custom);
        expect(parseServiceError).toHaveBeenCalledTimes(1);
    });

    it('does not retry an operation marked allowRetry false', async () => {
        vi.useFakeTimers();
        const fetch = vi.fn(async () => new Response('temporary', { status: 503 })) as unknown as HttpFetch;
        const executor = new HttpExecutor({
            endpoint: 'https://example.test/',
            fetch,
            retry: { limit: 2, baseDelay: 0, backoffLimit: 0 },
        });

        await expect(executor.execute(responseOperation('object', 'GET', (r) => r.text(), false)))
            .rejects.toBeInstanceOf(ServiceError);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('retries a retryable service response and then succeeds', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response('temporary', { status: 503 }))
            .mockResolvedValue(new Response('ok')) as unknown as HttpFetch;
        const executor = new HttpExecutor({
            endpoint: 'https://example.test/',
            fetch,
            retry: { limit: 1, baseDelay: 0, backoffLimit: 0 },
        });
        const pending = executor.execute(responseOperation('object', 'GET', (r) => r.text()));

        await vi.runAllTimersAsync();
        await expect(pending).resolves.toBe('ok');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('wraps download responses for progress when a callback is supplied', async () => {
        const fetch = vi.fn(async () => new Response('abc', { headers: { 'content-length': '3' } })) as unknown as HttpFetch;
        const executor = new HttpExecutor({ endpoint: 'https://example.test/', fetch, retry: { limit: 0 } });
        const onProgress = vi.fn();
        const operation = responseOperation('object', 'GET', (response) => response, undefined, 'download');
        const response = await executor.execute(operation, { onProgress });

        await expect(response.text()).resolves.toBe('abc');
        expect(onProgress).toHaveBeenLastCalledWith({ transferred: 3, total: 3 });
    });

    it('streams upload bodies to fetch and reports progress', async () => {
        const fetch = vi.fn(async (_url: URL, init?: RequestInit) => {
            const body = init?.body as ReadableStream<Uint8Array>;
            await new Response(body).text();
            return new Response('ok');
        });
        const executor = new HttpExecutor({ endpoint: 'https://example.test/', fetch, retry: { limit: 0 } });
        const onProgress = vi.fn();
        const operation: HttpOperation<string> = {
            progressDirection: 'upload',
            buildRequest: () => ({ path: 'object', method: 'PUT', body: 'abc' }),
            parseResponse: (response) => response.text(),
        };

        await expect(executor.execute(operation, { onProgress })).resolves.toBe('ok');
        expect(fetch.mock.calls[0][1]?.duplex).toBe('half');
        expect(onProgress).toHaveBeenLastCalledWith({ transferred: 3, total: 3 });
    });
});
