import { describe, expect, it, vi } from 'vitest';
import { S3Client } from '../src/s3-client.ts';
import type { SignParams, SignerConfig } from '../src/signer.ts';

function testSigner() {
    return vi.fn(async (params: SignParams, _config: SignerConfig) => ({
        url: params.url,
        headers: params.headers ?? {},
    }));
}

describe('S3Client', () => {
    it.each([
        '.', '..', './file', '../file', 'a/./b', 'a/../b', 'a/.', 'a/..', '/./b', 'a//../b',
    ])('rejects dot-segment key %s before signing or fetching', async (key) => {
        const signer = testSigner();
        const fetch = vi.fn(async () => new Response('ok'));
        const client = new S3Client({
            bucket: 'archive', region: 'us-east-1', signer,
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        await expect(client.upload(key, new Blob(['data']), { singleUploadThreshold: 0 })).rejects.toThrow(TypeError);
        await expect(client.download(key)).rejects.toThrow(TypeError);
        await expect(client.getDownloadUrl(key)).rejects.toThrow(TypeError);
        expect(signer).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects invalid upload options without signing or fetching', async () => {
        const signer = testSigner();
        const fetch = vi.fn(async () => new Response('ok'));
        const client = new S3Client({
            bucket: 'archive', region: 'us-east-1', signer,
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        await expect(client.upload('valid-key', new Blob(['data']), { concurrency: 0 }))
            .rejects.toThrow(RangeError);
        expect(signer).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
        ['.env', '/.env'],
        ['a..b', '/a..b'],
        ['a/%2E/b', '/a/%252E/b'],
        ['a/%2E%2E/b', '/a/%252E%252E/b'],
        ['a/ü.txt', '/a/%C3%BC.txt'],
        ['/leading', '//leading'],
        ['a//b', '/a//b'],
    ])('preserves accepted key %s for uploads, downloads, and presigned URLs', async (key, pathname) => {
        const signer = testSigner();
        const fetch = vi.fn(async () => new Response('ok'));
        const client = new S3Client({
            bucket: 'archive', region: 'us-east-1', signer,
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        await client.upload(key, new Blob(['data']));
        await client.download(key);
        await client.getDownloadUrl(key);
        expect(signer).toHaveBeenCalledTimes(3);
        for (const [params] of signer.mock.calls) {
            expect(new URL(params.url).pathname).toBe(pathname);
        }
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('exposes bucket, resolved region, and the AWS bucket endpoint', () => {
        const signer = testSigner();
        const client = new S3Client({ bucket: 'archive', region: 'eu-west-1', signer });

        expect(client.bucket).toBe('archive');
        expect(client.region).toBe('eu-west-1');
        expect(client.endpoint).toBe('https://archive.s3.eu-west-1.amazonaws.com/');
    });

    it('resolves auto region and a custom bucket endpoint', () => {
        const client = new S3Client({
            bucket: 'archive',
            endpoint: 'https://s3.example.test/root/?mode=1#fragment',
            signer: testSigner(),
        });

        expect(client.region).toBe('auto');
        expect(client.endpoint).toBe('https://s3.example.test/root/archive/');
    });

    it('requires a region when no custom endpoint is supplied', () => {
        expect(() => new S3Client({ bucket: 'archive', signer: testSigner() }))
            .toThrow('needs a region');
    });

    it('signs a download request and passes only the SignerConfig fields', async () => {
        const signer = testSigner();
        const fetch = vi.fn(async () => new Response('body'));
        const client = new S3Client({
            bucket: 'archive',
            region: 'us-east-1',
            credentials: { accessKeyId: 'key-id' },
            signer,
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        const response = await client.download('folder/a b');
        await expect(response.text()).resolves.toBe('body');
        expect(signer.mock.calls[0]?.[0]).toMatchObject({
            method: 'GET',
            url: 'https://archive.s3.us-east-1.amazonaws.com/folder/a%20b',
        });
        expect(Object.keys(signer.mock.calls[0]![1]).sort())
            .toEqual(['bucket', 'credentials', 'region']);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('creates a presigned download URL without making a fetch request', async () => {
        const signer = vi.fn(async (params: SignParams, _config: SignerConfig) => ({
            url: `${params.url}?signature=abc`,
            headers: {},
        }));
        const fetch = vi.fn(async () => new Response('unused'));
        const client = new S3Client({
            bucket: 'archive',
            region: 'us-east-1',
            signer,
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        await expect(client.getDownloadUrl('folder/a b', { expires: 60 }))
            .resolves.toBe('https://archive.s3.us-east-1.amazonaws.com/folder/a%20b?signature=abc');
        expect(signer.mock.calls[0]?.[0]).toMatchObject({
            method: 'GET',
            expires: 60,
            signQuery: true,
        });
        expect(fetch).not.toHaveBeenCalled();
    });
});
