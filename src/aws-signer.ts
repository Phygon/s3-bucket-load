import { prepareRequest } from "aws-signature";
import type { Signer, SignerConfig, SignParams, SignResult } from "./signer.ts";

/**
 * SigV4 material passed to a signature provider. It has no credentials object or separate access-key field;
 * protocol data such as a presigned URL's credential query parameter may appear inside the canonical request.
 */
export type SigningPayload = {
    /** Canonical HTTP request whose signature is being calculated. */
    canonicalRequest: string;
    /** SigV4 string-to-sign derived from the canonical request and scope. */
    stringToSign: string;
    /** Timestamp used to create the SigV4 scope. */
    datetime: string;
    /** AWS signing region. */
    region: string;
    /** AWS signing service, always `s3` for this adapter. */
    service: string;
};

/** Returns the hex-encoded SigV4 signature for a prepared payload. */
export type SignatureProvider = (payload: SigningPayload) => Promise<string>;

/**
 * Creates an S3 SigV4 signer that calculates signatures locally with `aws-signature`.
 * Requires `credentials.accessKeyId` and `credentials.secretAccessKey`; an optional session token is included.
 * Use this when the application can securely access the AWS secret key.
 *
 * @returns A signer for use in `S3Client` or any compatible signer consumer.
 * @throws {Error} When the returned signer runs without an access key ID or secret access key.
 * @example
 * ```ts
 * const signer = createAwsSigner();
 * const client = new S3Client({ bucket: 'archive', region: 'eu-west-1', credentials, signer });
 * ```
 */
export function createAwsSigner(): Signer {
    return async (params, config) => {
        const credentials = requireCredentials(config);
        if (!credentials.secretAccessKey) {
            throw new Error('Local AWS signing needs credentials.secretAccessKey');
        }

        const signer = prepareAwsRequest(params, config);
        const signedRequest = signer.sign();
        return toSignResult(signedRequest);
    };
}

/**
 * Creates an S3 SigV4 signer that delegates signature calculation to a caller-supplied provider.
 * The provider receives the canonical request, string-to-sign, timestamp, region, and service, then returns the signature.
 * The adapter requires `credentials.accessKeyId` to prepare the request, but passes the provider only a `SigningPayload`—
 * not a credentials object or separate access-key argument. Keep extra authentication or signing context in the provider's closure.
 *
 * @param provider Async function that returns the signature for the supplied SigV4 payload.
 * @returns A signer for use in `S3Client` or any compatible signer consumer.
 * @throws {Error} When the returned signer runs without `credentials.accessKeyId`; provider errors propagate.
 * @example
 * ```ts
 * const signer = createAwsSignerWithProvider(async ({ canonicalRequest, stringToSign, datetime }) => {
 *   const url = new URL('https://signer.example/sign');
 *   url.searchParams.set('canonical_request', canonicalRequest);
 *   url.searchParams.set('to_sign', stringToSign);
 *   url.searchParams.set('datetime', datetime);
 *   const response = await fetch(url);
 *   const { signature } = await response.json() as { signature: string };
 *   return signature;
 * });
 * ```
 */
export function createAwsSignerWithProvider(provider: SignatureProvider): Signer {
    return async (params, config) => {
        const signer = prepareAwsRequest(params, config);
        const { canonicalRequest, stringToSign } = signer.prepareSignature();
        const { datetime, region, service } = signer.scope;

        const signature = await provider({
            canonicalRequest,
            stringToSign,
            datetime,
            region,
            service,
        });

        const signedRequest = signer.addSignature(signature);
        return toSignResult(signedRequest);
    };
}

function prepareAwsRequest(params: SignParams, config: SignerConfig) {
    const credentials = requireCredentials(config);
    const signer = prepareRequest(
        {
            url: params.url,
            method: params.method ?? 'GET',
            headers: params.headers,
        },
        {
            credentials,
            region: config.region,
            service: 's3',
            ...(params.expires !== undefined && { expires: params.expires }),
            ...(params.signQuery !== undefined && { signQuery: params.signQuery }),
        },
    );

    return signer;
}

function requireCredentials(config: SignerConfig) {
    const credentials = config.credentials;
    if (!credentials?.accessKeyId) {
        throw new Error('AWS signing needs credentials.accessKeyId');
    }
    return credentials;
}

function toSignResult(request: { url: URL; headers: Headers }): SignResult {
    return {
        url: request.url.toString(),
        headers: request.headers,
    };
}
