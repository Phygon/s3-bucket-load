export { S3Client, type ClientConfig, type DownloadOptions } from "./s3-client.ts";

export type {
    Credentials,
    HttpMethod,
    SignOptions,
    SignParams,
    SignResult,
    Signer,
    SignerConfig,
} from "./signer.ts";

export {
    createAwsSigner,
    createAwsSignerWithProvider,
} from "./aws-signer.ts";
export type { SignatureProvider, SigningPayload } from "./aws-signer.ts";

export type {
    UploadOptions,
    UploadProgress,
    UploadResult,
    UploadState,
} from "./s3-upload.ts";

export { ServiceError } from "./service-error.ts";
export type { RetryOptions } from "./retry.ts";
export type { TransferProgress } from "./http-utils.ts";
