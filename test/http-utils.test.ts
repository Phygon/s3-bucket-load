import { describe, expect, it, vi } from 'vitest';
import {
    mergeHeaders,
    normalizeEndpoint,
    parseContentLength,
    prepareBody,
    responseWithProgress,
    trackByteProgress,
} from '../src/http-utils.ts';

const encoder = new TextEncoder();

function streamFrom(...chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
}

describe('mergeHeaders', () => {
    it('applies extra values over base values and skips undefined entries', () => {
        const headers = mergeHeaders(
            new Headers({ 'x-shared': 'base', 'x-base': 'yes' }),
            { 'x-shared': 'override', 'x-extra': 'yes', 'x-skip': undefined },
        );
        expect(headers.get('x-shared')).toBe('override');
        expect(headers.get('x-base')).toBe('yes');
        expect(headers.get('x-extra')).toBe('yes');
        expect(headers.has('x-skip')).toBe(false);
    });
});

describe('parseContentLength', () => {
    it.each([
        ['0', 0],
        ['42', 42],
        [null, undefined],
        ['', undefined],
        ['-1', undefined],
        ['3.5', undefined],
        ['9007199254740992', undefined],
    ] as const)('parses %s as %s', (value, expected) => {
        expect(parseContentLength(value)).toBe(expected);
    });
});

describe('normalizeEndpoint', () => {
    it('adds a trailing slash while preserving the endpoint path', () => {
        expect(normalizeEndpoint('https://example.test/base').href).toBe('https://example.test/base/');
    });

    it('leaves an existing trailing slash in place', () => {
        expect(normalizeEndpoint(new URL('https://example.test/base/')).href)
            .toBe('https://example.test/base/');
    });
});

describe('trackByteProgress', () => {
    it('reports cumulative bytes as the stream is consumed', async () => {
        const onProgress = vi.fn();
        const result = await new Response(trackByteProgress(streamFrom('ab', 'c'), 3, onProgress)).text();
        expect(result).toBe('abc');
        expect(onProgress).toHaveBeenLastCalledWith({ transferred: 3, total: 3 });
    });

    it('forwards cancellation to the source stream', async () => {
        const onCancel = vi.fn();
        const source = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(encoder.encode('chunk')); },
            cancel: onCancel,
        });
        const reader = trackByteProgress(source).getReader();
        await reader.read();
        await reader.cancel('stop');
        expect(onCancel).toHaveBeenCalledWith('stop');
    });
});

describe('prepareBody', () => {
    it('leaves a body unchanged when upload progress is not requested', () => {
        expect(prepareBody('payload', 'upload')).toEqual({ body: 'payload' });
    });

    it('adds duplex for an untracked readable stream', () => {
        const stream = streamFrom('payload');
        expect(prepareBody(stream, 'upload')).toEqual({ body: stream, duplex: true });
    });

    it('wraps an upload body and reports progress when requested', async () => {
        const onProgress = vi.fn();
        const prepared = prepareBody('payload', 'upload', onProgress);
        expect(prepared.duplex).toBe(true);
        expect(await new Response(prepared.body as ReadableStream<Uint8Array>).text()).toBe('payload');
        expect(onProgress).toHaveBeenLastCalledWith({ transferred: 7, total: 7 });
    });
});

describe('responseWithProgress', () => {
    it('preserves response metadata and reports downloaded bytes', async () => {
        const onProgress = vi.fn();
        const original = new Response('abc', {
            status: 201,
            statusText: 'Created',
            headers: { 'content-length': '3', 'x-test': 'kept' },
        });
        const response = responseWithProgress(original, onProgress);
        expect(response.status).toBe(201);
        expect(response.statusText).toBe('Created');
        expect(response.headers.get('x-test')).toBe('kept');
        expect(await response.text()).toBe('abc');
        expect(onProgress).toHaveBeenLastCalledWith({ transferred: 3, total: 3 });
    });

    it('returns the original response when there is no body', () => {
        const response = new Response(null);
        expect(responseWithProgress(response, vi.fn())).toBe(response);
    });
});
