import { describe, expect, it, vi } from 'vitest';
import { S3Client } from '../src/s3-client.ts';
import type { SignParams, SignerConfig } from '../src/signer.ts';

function testSigner() {
    return vi.fn(async (params: SignParams, _config: SignerConfig) => ({
        url: params.url,
        headers: new Headers({ authorization: 'AWS4-HMAC-SHA256 test', 'x-signed-by': 'signer' }),
    }));
}

describe('S3Client signer integration', () => {
    it('adds the unsigned payload header before signing downloads and forwards signer headers to fetch', async () => {
        const signer = testSigner();
        const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('download body'));
        const client = new S3Client({
            bucket: 'archive',
            region: 'eu-west-1',
            signer,
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        const response = await client.download('folder/雪 file.txt');
        const [signParams] = signer.mock.calls[0]!;
        const [fetchUrl, fetchInit] = fetch.mock.calls[0]!;

        expect(await response.text()).toBe('download body');
        expect(signParams.method).toBe('GET');
        expect(signParams.url).toBe(
            'https://archive.s3.eu-west-1.amazonaws.com/folder/%E9%9B%AA%20file.txt',
        );
        expect(new Headers(signParams.headers).get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
        expect(String(fetchUrl)).toBe(signParams.url);
        expect(new Headers(fetchInit?.headers).get('authorization')).toBe('AWS4-HMAC-SHA256 test');
        expect(new Headers(fetchInit?.headers).get('x-signed-by')).toBe('signer');
    });

    it('signs single-PUT uploads and forwards the returned headers and method', async () => {
        const signer = testSigner();
        const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
            new Response('', { headers: { etag: '"upload-etag"' } }),
        );
        const client = new S3Client({
            bucket: 'archive',
            region: 'eu-west-1',
            signer,
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        const result = await client.upload(
            'folder/object.txt',
            new Blob(['payload'], { type: 'text/plain' }),
        );
        const [signParams] = signer.mock.calls[0]!;
        const [fetchUrl, fetchInit] = fetch.mock.calls[0]!;

        expect(result).toMatchObject({ mode: 'single', size: 7, etag: 'upload-etag' });
        expect(signParams.method).toBe('PUT');
        expect(signParams.url).toBe('https://archive.s3.eu-west-1.amazonaws.com/folder/object.txt');
        expect(new Headers(signParams.headers).get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
        expect(new Headers(fetchInit?.headers).get('authorization')).toBe('AWS4-HMAC-SHA256 test');
        expect(new Headers(fetchInit?.headers).get('x-signed-by')).toBe('signer');
        expect(fetchInit?.method).toBe('PUT');
        expect(String(fetchUrl)).toBe(signParams.url);
    });

    it('asks the signer for an encoded presigned download URL without fetching', async () => {
        const signer = vi.fn(async (params: SignParams, _config: SignerConfig) => ({
            url: `${params.url}?X-Amz-Signature=fake`,
            headers: new Headers(),
        }));
        const fetch = vi.fn(async () => new Response('unused'));
        const client = new S3Client({
            bucket: 'archive',
            region: 'eu-west-1',
            signer,
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        await expect(client.getDownloadUrl('folder/雪 file.txt', { expires: 90 })).resolves.toBe(
            'https://archive.s3.eu-west-1.amazonaws.com/folder/%E9%9B%AA%20file.txt?X-Amz-Signature=fake',
        );
        expect(signer.mock.calls[0]?.[0]).toMatchObject({
            method: 'GET',
            expires: 90,
            signQuery: true,
        });
        expect(fetch).not.toHaveBeenCalled();
    });
});

const COMPATIBILITY_ENDPOINTS: Array<{
    provider: string;
    endpoint: string;
    region?: string;
    expectedRegion: string;
}> = [
    {
        provider: 'Cloudflare R2',
        endpoint: 'https://test-account.r2.cloudflarestorage.com',
        expectedRegion: 'auto',
    },
    {
        provider: 'Backblaze B2',
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        region: 'us-west-004',
        expectedRegion: 'us-west-004',
    },
];

describe.each(COMPATIBILITY_ENDPOINTS)('$provider endpoint compatibility', ({ endpoint, region, expectedRegion }) => {
    it('uses the configured region and path-style object URL', async () => {
        const signer = testSigner();
        const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('object body'));
        const client = new S3Client({
            bucket: 'archive',
            endpoint,
            ...(region !== undefined && { region }),
            signer,
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        const response = await client.download('folder/green video.mp4');
        const [signParams, signerConfig] = signer.mock.calls[0]!;
        const [fetchUrl] = fetch.mock.calls[0]!;
        const expectedUrl = `${endpoint}/archive/folder/green%20video.mp4`;

        expect(await response.text()).toBe('object body');
        expect(client.region).toBe(expectedRegion);
        expect(client.endpoint).toBe(`${endpoint}/archive/`);
        expect(signParams.url).toBe(expectedUrl);
        expect(signerConfig.region).toBe(expectedRegion);
        expect(String(fetchUrl)).toBe(expectedUrl);
    });

    it('creates a path-style presigned GET URL with the configured region', async () => {
        const signer = vi.fn(async (params: SignParams, _config: SignerConfig) => ({
            url: `${params.url}?X-Amz-Signature=fake`,
            headers: new Headers(),
        }));
        const fetch = vi.fn(async () => new Response('unused'));
        const client = new S3Client({
            bucket: 'archive',
            endpoint,
            ...(region !== undefined && { region }),
            signer,
            fetch: fetch as unknown as typeof globalThis.fetch,
        });

        await expect(client.getDownloadUrl('folder/green video.mp4')).resolves.toBe(
            `${endpoint}/archive/folder/green%20video.mp4?X-Amz-Signature=fake`,
        );
        expect(signer.mock.calls[0]?.[0]).toMatchObject({ method: 'GET', signQuery: true });
        expect(signer.mock.calls[0]?.[1].region).toBe(expectedRegion);
        expect(fetch).not.toHaveBeenCalled();
    });
});
