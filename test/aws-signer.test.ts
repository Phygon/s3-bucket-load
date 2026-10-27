import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSigningKey, hmacSha256 } from 'aws-signature';
import {
    createAwsSigner,
    createAwsSignerWithProvider,
    type SigningPayload,
} from '../src/aws-signer.ts';
import type { SignParams, SignerConfig } from '../src/signer.ts';

const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const FIXED_DATE = new Date('2025-02-03T04:05:06.000Z');

function config(overrides: Partial<SignerConfig> = {}): SignerConfig {
    return {
        bucket: 'archive',
        region: 'eu-west-1',
        credentials: {
            accessKeyId: 'AKIDEXAMPLE',
            secretAccessKey: SECRET,
            ...overrides.credentials,
        },
        ...overrides,
    };
}

function request(overrides: Partial<SignParams> = {}): SignParams {
    return {
        url: 'https://archive.s3.eu-west-1.amazonaws.com/folder/object.txt',
        method: 'PUT',
        headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
        ...overrides,
    };
}

describe('AWS signer adapter', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('signs request headers locally through aws-signature', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(FIXED_DATE);

        const result = await createAwsSigner()(request(), config());
        const headers = new Headers(result.headers);

        expect(result.url).toBe(request().url);
        expect(headers.get('authorization')).toMatch(
            /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20250203\/eu-west-1\/s3\/aws4_request, SignedHeaders=.*Signature=[a-f0-9]{64}$/,
        );
        expect(headers.get('x-amz-date')).toBe('20250203T040506Z');
        expect(headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
    });

    it('throws a clear error when local signing has no secret key', async () => {
        const signer = createAwsSigner();
        const cfg = config({ credentials: { accessKeyId: 'AKIDEXAMPLE' } });

        await expect(signer(request(), cfg)).rejects.toThrow(
            'Local AWS signing needs credentials.secretAccessKey',
        );
    });

    it('creates a presigned URL with expiry and a session token', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(FIXED_DATE);
        const cfg = config({
            credentials: {
                accessKeyId: 'AKIDEXAMPLE',
                secretAccessKey: SECRET,
                sessionToken: 'session-token-value',
            },
        });

        const result = await createAwsSigner()(
            request({ method: 'GET', headers: {}, signQuery: true, expires: 75 }),
            cfg,
        );
        const url = new URL(result.url);

        expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
        expect(url.searchParams.get('X-Amz-Credential')).toBe(
            'AKIDEXAMPLE/20250203/eu-west-1/s3/aws4_request',
        );
        expect(url.searchParams.get('X-Amz-Expires')).toBe('75');
        expect(url.searchParams.get('X-Amz-Security-Token')).toBe('session-token-value');
        expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    });

    it('uses canonical X-Amz query names when signing through a provider', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(FIXED_DATE);
        const provider = vi.fn(async (_payload: SigningPayload) => 'provider-signature');
        const cfg = config({ credentials: { accessKeyId: 'AKIDEXAMPLE' } });

        const result = await createAwsSignerWithProvider(provider)(
            request({ method: 'GET', headers: {}, signQuery: true, expires: 75 }),
            cfg,
        );
        const canonicalRequest = provider.mock.calls[0]?.[0].canonicalRequest;
        const url = new URL(result.url);

        expect(canonicalRequest).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
        expect(canonicalRequest).toContain('X-Amz-Expires=75');
        expect(url.searchParams.get('X-Amz-Signature')).toBe('provider-signature');
        expect(url.searchParams.has('x-amz-signature')).toBe(false);
    });

    it('puts a session token in the signed request headers', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(FIXED_DATE);
        const cfg = config({
            credentials: {
                accessKeyId: 'AKIDEXAMPLE',
                secretAccessKey: SECRET,
                sessionToken: 'session-token-value',
            },
        });

        const result = await createAwsSigner()(request(), cfg);

        expect(new Headers(result.headers).get('x-amz-security-token')).toBe('session-token-value');
    });

    it('defaults the provider-signed HTTP method to GET', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(FIXED_DATE);
        const provider = vi.fn(async (_payload: SigningPayload) => 'provider-signature');
        const cfg = config({ credentials: { accessKeyId: 'AKIDEXAMPLE' } });

        await createAwsSignerWithProvider(provider)(request({ method: undefined }), cfg);

        expect(provider.mock.calls[0]?.[0].canonicalRequest.startsWith('GET\n')).toBe(true);
    });

    it('passes only signing material to the provider and applies its signature', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(FIXED_DATE);
        const provider = vi.fn(async (_payload: SigningPayload) => 'provider-signature');
        const cfg = config({ credentials: { accessKeyId: 'AKIDEXAMPLE' } });

        const result = await createAwsSignerWithProvider(provider)(request(), cfg);
        const payload = provider.mock.calls[0]?.[0];
        const headers = new Headers(result.headers);

        expect(payload).toMatchObject({
            datetime: '20250203T040506Z',
            region: 'eu-west-1',
            service: 's3',
        });
        expect(payload?.canonicalRequest).toContain('PUT\n/folder/object.txt\n');
        expect(payload?.stringToSign).toContain('20250203T040506Z');
        expect(Object.keys(payload ?? {}).sort()).toEqual([
            'canonicalRequest',
            'datetime',
            'region',
            'service',
            'stringToSign',
        ]);
        expect(payload).not.toHaveProperty('accessKeyId');
        expect(payload).not.toHaveProperty('secretAccessKey');
        expect(payload?.canonicalRequest).not.toContain(SECRET);
        expect(headers.get('authorization')).toContain('Signature=provider-signature');
    });

    it('propagates a provider failure', async () => {
        const providerError = new Error('remote signer unavailable');
        const provider = vi.fn(async () => {
            throw providerError;
        });
        const cfg = config({ credentials: { accessKeyId: 'AKIDEXAMPLE' } });

        await expect(createAwsSignerWithProvider(provider)(request(), cfg)).rejects.toBe(providerError);
    });

    it('produces the same signature locally and with an equivalent provider', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(FIXED_DATE);
        const cfg = config();
        const provider = async (payload: SigningPayload) => {
            const signingKey = getSigningKey(
                SECRET,
                payload.datetime.slice(0, 8),
                payload.region,
                payload.service,
            );
            return hmacSha256(signingKey, payload.stringToSign, 'hex');
        };

        const [localResult, providerResult] = await Promise.all([
            createAwsSigner()(request(), cfg),
            createAwsSignerWithProvider(provider)(request(), cfg),
        ]);

        expect(providerResult.url).toBe(localResult.url);
        expect(new Headers(providerResult.headers).get('authorization'))
            .toBe(new Headers(localResult.headers).get('authorization'));
    });

    it.each([
        {
            providerName: 'Cloudflare R2',
            region: 'auto',
            host: 'test-account.r2.cloudflarestorage.com',
        },
        {
            providerName: 'Backblaze B2',
            region: 'us-west-004',
            host: 's3.us-west-004.backblazeb2.com',
        },
    ])('uses the $providerName region in the provider signing scope', async ({ region, host }) => {
        const provider = vi.fn(async (_payload: SigningPayload) => 'provider-signature');
        const cfg = config({ region, credentials: { accessKeyId: 'AKIDEXAMPLE' } });

        await createAwsSignerWithProvider(provider)(
            request({ url: `https://${host}/archive/folder/object.mp4` }),
            cfg,
        );

        const payload = provider.mock.calls[0]?.[0];
        expect(payload?.region).toBe(region);
        expect(payload?.service).toBe('s3');
        expect(payload?.stringToSign).toContain(
            `${payload?.datetime.slice(0, 8)}/${region}/s3/aws4_request`,
        );
    });
});
