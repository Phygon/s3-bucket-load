import { map } from "concurrent-iteration";
import type { ProgressCallback } from "./http-utils.ts";
import { HttpExecutor } from "./http-executor.ts";
import {
    abortMultipartUploadOperation,
    completeMultipartUploadOperation,
    createMultipartUploadOperation,
    putObjectOperation,
    uploadPartOperation,
} from "./s3-operations.ts";

/** Multipart tuning options; omitted values use the documented defaults. */
type MultipartUploadOptions = {
    /** Size threshold in bytes: uploads at or below it use one PUT (default 5 MiB). */
    singleUploadThreshold?: number;
    /** Target size of each multipart chunk in bytes (default 5 MiB). */
    partSize?: number;
    /** Maximum number of part uploads in flight (default 4). */
    concurrency?: number;
    /** Minimum multipart chunk size in bytes (default 5 MiB). */
    minPartSize?: number;
    /** Maximum allowed multipart part count (default 10,000). */
    maxPartCount?: number;
};

/** Aggregate byte and part progress for an upload. */
export type UploadProgress = {
    /** Total bytes uploaded so far. */
    transferred: number;
    /** Total size of the source Blob in bytes. */
    total: number;
    /** Number of fully uploaded parts. */
    completedParts: number;
    /** Total number of parts in this upload. */
    totalParts: number;
};

/** Upload lifecycle: idle, uploading, completing, then completed; failures end as failed or cancelled. */
export type UploadState =
    | 'idle'
    | 'uploading'
    | 'completing'
    | 'completed'
    | 'failed'
    | 'cancelled';

/** Controls cancellation, progress reporting, and multipart behavior for one upload. */
export type UploadOptions = Partial<MultipartUploadOptions> & {
    /** Cancels the upload and triggers best-effort multipart cleanup. */
    signal?: AbortSignal;
    /** Called as bytes are transferred and when parts complete. */
    onProgress?: (progress: UploadProgress) => void;
    /** Called when the upload changes lifecycle state. */
    onState?: (state: UploadState) => void;
};

/** Outcome and transfer mode for a completed upload. */
export type UploadResult = {
    /** ETag returned by S3, when available. */
    etag?: string;
    /** Object location returned by S3, when available. */
    location?: string;
    /** Whether the upload used one PUT or multipart transfer. */
    mode: 'single' | 'multipart';
    /** Source size in bytes. */
    size: number;
};

export type ObjectUploadConfig = {
    key: string;
    source: Blob;
    executor: HttpExecutor;
    options?: UploadOptions;
};

type ResolvedOptions = Required<MultipartUploadOptions> & Pick<UploadOptions, 'signal' | 'onProgress' | 'onState'>;

type PartRange = {
    partNumber: number;
    start: number;
    end: number;
    size: number;
};

const MB = 1024 * 1024;
const DEFAULT_OPTIONS: Required<MultipartUploadOptions> = {
    singleUploadThreshold: 5 * MB,
    partSize: 5 * MB,
    concurrency: 4,
    minPartSize: 5 * MB,
    maxPartCount: 10_000,
};
const CLEANUP_TIMEOUT_MS = 10_000;

/** Combines per-part byte counts into upload-wide progress reports. */
class ProgressTracker {
    private readonly partSizes: readonly number[];
    private readonly totalSize: number;
    private readonly onProgress: UploadOptions['onProgress'];
    private readonly transferredByPart: number[];
    private completedParts = 0;

    constructor(partSizes: readonly number[], totalSize: number, onProgress: UploadOptions['onProgress']) {
        this.partSizes = partSizes;
        this.totalSize = totalSize;
        this.onProgress = onProgress;
        this.transferredByPart = partSizes.map(() => 0);
    }

    /** Returns a byte-progress callback for one part, or undefined when nobody observes progress. */
    partCallback(partIndex: number): ProgressCallback | undefined {
        if (!this.onProgress) {
            return undefined;
        }
        return ({ transferred }) => this.report(partIndex, transferred);
    }

    /** Marks a part as fully transferred and reports it. */
    completePart(partIndex: number): void {
        this.completedParts += 1;
        this.report(partIndex, this.partSizes[partIndex]);
    }

    private report(partIndex: number, transferred: number): void {
        if (!this.onProgress) {
            return;
        }
        const partSize = this.partSizes[partIndex];
        this.transferredByPart[partIndex] = Math.min(Math.max(transferred, 0), partSize);
        this.onProgress({
            transferred: this.transferredByPart.reduce((total, value) => total + value, 0),
            total: this.totalSize,
            completedParts: this.completedParts,
            totalParts: this.partSizes.length,
        });
    }
}

/** Selects and runs a single-PUT or multipart upload using only S3 operations and HttpExecutor. */
export class S3ObjectUpload {
    private readonly key: string;
    private readonly source: Blob;
    private readonly executor: HttpExecutor;
    private readonly options: ResolvedOptions;
    private currentState: UploadState = 'idle';

    constructor(config: ObjectUploadConfig) {
        this.key = config.key;
        this.source = config.source;
        this.executor = config.executor;
        const options = { ...DEFAULT_OPTIONS, ...config.options };
        validateInteger('singleUploadThreshold', options.singleUploadThreshold, 0);
        validateInteger('partSize', options.partSize, 1);
        validateInteger('minPartSize', options.minPartSize, 1);
        validateInteger('concurrency', options.concurrency, 1);
        validateInteger('maxPartCount', options.maxPartCount, 1);
        this.options = options;
    }

    get state(): UploadState {
        return this.currentState;
    }

    private setState(state: UploadState): void {
        if (this.currentState === state) {
            return;
        }
        this.currentState = state;
        try {
            this.options.onState?.(state);
        } catch {
            // State observers must not change the outcome of the upload.
        }
    }

    async start(): Promise<UploadResult> {
        if (this.currentState !== 'idle') {
            throw new Error('upload was already started');
        }

        try {
            this.options.signal?.throwIfAborted();
            this.setState('uploading');

            const result = this.source.size <= this.options.singleUploadThreshold
                ? await this.uploadSingle()
                : await this.uploadMultipart();
            this.setState('completed');
            return result;
        } catch (error) {
            this.setState(this.options.signal?.aborted ? 'cancelled' : 'failed');
            throw error;
        }
    }

    private async uploadSingle(): Promise<UploadResult> {
        const size = this.source.size;
        const progress = new ProgressTracker([size], size, this.options.onProgress);
        const result = await this.executor.execute(
            putObjectOperation({
                key: this.key,
                body: this.source,
                contentType: this.source.type || undefined,
            }),
            { signal: this.options.signal, onProgress: progress.partCallback(0) },
        );
        progress.completePart(0);
        return { ...result, mode: 'single', size };
    }

    private async uploadMultipart(): Promise<UploadResult> {
        const { uploadId } = await this.executor.execute(
            createMultipartUploadOperation({
                key: this.key,
                contentType: this.source.type || undefined,
            }),
            { signal: this.options.signal },
        );

        try {
            const receipts = await this.uploadParts(uploadId);
            this.setState('completing');
            const result = await this.executor.execute(
                completeMultipartUploadOperation({ key: this.key, uploadId, parts: receipts }),
                { signal: this.options.signal },
            );
            return { ...result, mode: 'multipart', size: this.source.size };
        } catch (error) {
            await this.abortQuietly(uploadId);
            throw error;
        }
    }

    private async uploadParts(uploadId: string): Promise<Array<{ partNumber: number; etag: string }>> {
        const parts = this.prepareParts();
        const progress = new ProgressTracker(
            parts.map((part) => part.size),
            this.source.size,
            this.options.onProgress,
        );
        const failureController = new AbortController();
        const signal = this.options.signal
            ? AbortSignal.any([this.options.signal, failureController.signal])
            : failureController.signal;

        return map(
            parts,
            async (part, partIndex) => {
                try {
                    const receipt = await this.executor.execute(
                        uploadPartOperation({
                            key: this.key,
                            uploadId,
                            partNumber: part.partNumber,
                            body: this.source.slice(part.start, part.end),
                        }),
                        { signal, onProgress: progress.partCallback(partIndex) },
                    );
                    progress.completePart(partIndex);
                    return receipt;
                } catch (error) {
                    // Cancel sibling requests, then let map preserve and rethrow the first error.
                    failureController.abort(error);
                    throw error;
                }
            },
            { concurrency: this.options.concurrency },
        );
    }

    private prepareParts(): PartRange[] {
        const partSize = Math.max(
            this.options.partSize,
            this.options.minPartSize,
            Math.ceil(this.source.size / this.options.maxPartCount),
        );
        const partCount = Math.ceil(this.source.size / partSize);
        if (partCount > this.options.maxPartCount) {
            throw new RangeError(`Multipart upload requires ${partCount} parts, exceeding the limit of ${this.options.maxPartCount}`);
        }

        return Array.from({ length: partCount }, (_, index) => {
            const start = index * partSize;
            const end = Math.min(start + partSize, this.source.size);
            return {
                partNumber: index + 1,
                start,
                end,
                size: end - start,
            };
        });
    }

    private async abortQuietly(uploadId: string): Promise<void> {
        try {
            await this.executor.execute(
                abortMultipartUploadOperation({ key: this.key, uploadId }),
                { signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
            );
        } catch {
            // Cleanup is best-effort; preserve the original upload failure.
        }
    }
}

function validateInteger(name: string, value: number, minimum: number): void {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}`);
    }
}
