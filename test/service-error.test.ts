import { describe, expect, it } from 'vitest';
import { parseRetryAfter, toServiceError } from '../src/service-error.ts';

describe('parseRetryAfter', () => {
    it('parses delta-seconds as milliseconds', () => {
        expect(parseRetryAfter('12', 0)).toBe(12_000);
    });

    it('parses an HTTP date relative to the supplied clock', () => {
        const now = Date.UTC(2025, 0, 1, 0, 0, 0);
        const date = new Date(now + 5_000).toUTCString();
        expect(parseRetryAfter(date, now)).toBe(5_000);
    });

    it('clamps a past HTTP date to zero', () => {
        const now = Date.UTC(2025, 0, 1, 0, 0, 0);
        expect(parseRetryAfter(new Date(now - 1_000).toUTCString(), now)).toBe(0);
    });

    it.each([null, '', 'tomorrow', 'not-a-date'])('returns undefined for invalid input %s', (value) => {
        expect(parseRetryAfter(value, 0)).toBeUndefined();
    });
});

describe('toServiceError', () => {
    it('keeps service details and parses Retry-After', () => {
        const error = toServiceError({
            status: 503,
            message: 'temporarily unavailable',
            code: 'SlowDown',
            requestId: 'req-1',
            retryable: true,
        }, new Headers({ 'retry-after': '3' }));

        expect(error).toMatchObject({
            name: 'ServiceError',
            status: 503,
            message: 'temporarily unavailable',
            code: 'SlowDown',
            requestId: 'req-1',
            retryable: true,
            retryAfter: 3_000,
        });
        expect(error).toBeInstanceOf(Error);
    });
});
