import { afterEach, describe, expect, it, vi } from 'vitest';
import { retry, isRetryableError } from '../src/retry.ts';
import { ServiceError } from '../src/service-error.ts';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function retryableServiceError(status = 503, retryAfter?: number, retryable?: boolean): ServiceError {
    return new ServiceError({ status, message: 'temporary failure', retryAfter, retryable });
}

describe('isRetryableError', () => {
    it.each([408, 429, 500, 503])('retries service status %i by default', (status) => {
        expect(isRetryableError(retryableServiceError(status))).toBe(true);
    });

    it('honors a service-provided retryable override', () => {
        expect(isRetryableError(retryableServiceError(400, undefined, true))).toBe(true);
        expect(isRetryableError(retryableServiceError(503, undefined, false))).toBe(false);
    });

    it('treats TypeError as retryable but not an ordinary Error', () => {
        expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
        expect(isRetryableError(new Error('application failure'))).toBe(false);
    });
});

describe('retry', () => {
    it('returns a successful result without another attempt', async () => {
        const operation = vi.fn().mockResolvedValue('ok');
        await expect(retry(operation, { limit: 2, baseDelay: 0, backoffLimit: 0 })).resolves.toBe('ok');
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it.each([408, 429, 500])('retries HTTP %i and returns the later result', async (status) => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const operation = vi.fn()
            .mockRejectedValueOnce(retryableServiceError(status))
            .mockResolvedValue('ok');

        const pending = retry(operation, { limit: 1, baseDelay: 10, backoffLimit: 10 });
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toBe('ok');
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it('interprets limit as retries after the first attempt', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const operation = vi.fn().mockRejectedValue(retryableServiceError());

        const pending = retry(operation, { limit: 2, baseDelay: 0, backoffLimit: 0 });
        const assertion = expect(pending).rejects.toBeInstanceOf(ServiceError);
        await vi.runAllTimersAsync();
        await assertion;
        expect(operation).toHaveBeenCalledTimes(3);
    });

    it('does not retry an error marked non-retryable', async () => {
        const failure = retryableServiceError(503, undefined, false);
        const operation = vi.fn().mockRejectedValue(failure);
        await expect(retry(operation, { limit: 3, baseDelay: 0, backoffLimit: 0 })).rejects.toBe(failure);
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('retries a TypeError network failure', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const operation = vi.fn()
            .mockRejectedValueOnce(new TypeError('network'))
            .mockResolvedValue('ok');
        const pending = retry(operation, { limit: 1, baseDelay: 0, backoffLimit: 0 });
        await vi.runAllTimersAsync();
        await expect(pending).resolves.toBe('ok');
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it('does not retry ordinary errors', async () => {
        const failure = new Error('programming error');
        const operation = vi.fn().mockRejectedValue(failure);
        await expect(retry(operation, { limit: 3, baseDelay: 0, backoffLimit: 0 })).rejects.toBe(failure);
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('does not wait when Retry-After exceeds maxRetryAfter', async () => {
        const failure = retryableServiceError(503, 101);
        const operation = vi.fn().mockRejectedValue(failure);
        await expect(retry(operation, {
            limit: 2,
            baseDelay: 0,
            backoffLimit: 0,
            maxRetryAfter: 100,
        })).rejects.toBe(failure);
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('rejects with the abort reason when aborted during backoff', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const controller = new AbortController();
        const reason = new Error('cancelled');
        const operation = vi.fn().mockRejectedValue(retryableServiceError());
        const pending = retry(operation, { limit: 2, baseDelay: 100, backoffLimit: 100 }, controller.signal);
        const assertion = expect(pending).rejects.toBe(reason);

        await vi.advanceTimersByTimeAsync(0);
        controller.abort(reason);
        await assertion;
        expect(operation).toHaveBeenCalledTimes(1);
    });
});
