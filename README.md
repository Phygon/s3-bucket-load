# s3-bucket-load

> A TypeScript client for Amazon S3 and S3-compatible object storage, with signed requests, retries, and multipart uploads.

The library supports single-PUT and multipart uploads, upload progress, download progress, presigned download URLs and configurable request signing.

## Quick start

```ts
import { S3Client, createAwsSigner } from 's3-bucket-load';

const client = new S3Client({
    bucket: 'my-bucket',
    region: 'eu-west-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        sessionToken: process.env.AWS_SESSION_TOKEN,
    },
    signer: createAwsSigner(),
});

const upload = await client.upload(
    'reports/summary.csv',
    new Blob(['name,total\nexample,42\n'], { type: 'text/csv' }),
);

const response = await client.download('reports/summary.csv');
const csv = await response.text();

const downloadUrl = await client.getDownloadUrl('reports/summary.csv', { expires: 900 });
```

`createAwsSigner()` signs requests using local credentials. It requires an access key ID and secret access key; an optional session token is supported.
`createAwsSignerWithProvider()` signs requests with an external signature provider.

## Creating a client

`S3Client` works with one bucket. Supply a `signer` and either an AWS region or a custom endpoint.

| `ClientConfig` property | Required | Description |
| --- | --- | --- |
| `bucket` | Yes | Bucket name. |
| `signer` | Yes | Async function that signs requests and returns a URL and headers. Use `createAwsSigner()`, `createAwsSignerWithProvider()`, or your own implementation. |
| `region` | Unless `endpoint` is set | AWS signing and endpoint region. Defaults to `auto` when a custom `endpoint` is supplied. |
| `endpoint` | No | Custom S3-compatible endpoint. The bucket is appended as a path segment; the client uses path-style addressing. |
| `credentials` | No | AWS credentials. The AWS signer needs `accessKeyId`; local signing also needs `secretAccessKey`. `sessionToken` is optional. A custom signer may use its own credential source. |
| `fetch` | No | Fetch implementation. Defaults to `globalThis.fetch`. |
| `retry` | No | Partial retry configuration; unset values use the defaults described below. |

For AWS endpoints, the client builds a virtual-hosted bucket endpoint from `bucket` and `region`. With a custom `endpoint`, it uses path-style addressing and defaults the region to `auto`.

The client exposes read-only `bucket`, `region`, and resolved `endpoint` getters.

## Uploading objects

```ts
const controller = new AbortController();

const result = await client.upload(
    'archive/data.bin',
    new Blob(['example binary data'], { type: 'application/octet-stream' }),
    {
        signal: controller.signal,
        onProgress: ({ transferred, total, completedParts, totalParts }) => {
            console.log({ transferred, total, completedParts, totalParts });
        },
        onState: (state) => console.log(state),
    },
);

console.log(result.mode, result.size, result.etag);
```

The client uses a single PUT for objects at or below `singleUploadThreshold` and multipart upload for larger objects. Defaults are 5 MiB for the threshold, 5 MiB for `partSize`, and four concurrent part uploads.

`UploadOptions` supports:

| Option | Default | Description |
| --- | --- | --- |
| `signal` | — | Abort signal for the upload. |
| `onProgress` | — | Receives `transferred`, `total`, `completedParts`, and `totalParts`. |
| `onState` | — | Receives `idle`, `uploading`, `completing`, `completed`, `failed`, or `cancelled`. |
| `singleUploadThreshold` | 5 MiB | Maximum size for a single-PUT upload. |
| `partSize` | 5 MiB | Target multipart part size. |
| `concurrency` | 4 | Maximum concurrent part uploads. |
| `minPartSize` | 5 MiB | Minimum part size used when preparing multipart uploads. |
| `maxPartCount` | 10,000 | Maximum number of parts. |

`upload()` resolves to an `UploadResult` containing `mode` (`single` or `multipart`), `size`, and any available `etag` or `location`.

## Downloading objects

`download(key, options?)` resolves to a `Response`. Consume its body using methods such as `text()`, `json()`, or `arrayBuffer()`.

`DownloadOptions` accepts:

- `signal` — aborts the request or response-body read.
- `onProgress` — receives `{ transferred, total }` as the response body is consumed. `total` is undefined when the response does not provide a valid `Content-Length`.

## Presigned download URLs

`getDownloadUrl(key, options?)` returns a presigned GET URL and makes no network request. Its options currently include `expires` in seconds; the signing library defaults this to 3,600 seconds when omitted.

Treat presigned URLs as bearer credentials: anyone holding the URL can use it until it expires or the underlying credentials are no longer valid.

## Signing

### Local signing

Use `createAwsSigner()` to sign with the supplied AWS credentials in the current process:

```ts
import { S3Client, createAwsSigner } from 's3-client';

const client = new S3Client({
    bucket: 'my-bucket',
    region: 'eu-west-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
    signer: createAwsSigner(),
});
```

### Remote signature provider

Use `createAwsSignerWithProvider()` when another service or key system calculates the signature. The provider receives a `SigningPayload` with `canonicalRequest`, `stringToSign`, `datetime`, `region`, and `service`, and returns the signature string. It does not receive credentials.

This example calls a service that accepts the first three fields as query parameters and responds with `{ "signature": "..." }`:

```ts
import {
    S3Client,
    createAwsSignerWithProvider,
    type SignatureProvider,
} from 's3-client';

const signatureProvider: SignatureProvider = async ({
    canonicalRequest,
    stringToSign,
    datetime,
}) => {
    const url = new URL('https://signer.example/signature');
    url.search = new URLSearchParams({
        canonical_request: canonicalRequest,
        to_sign: stringToSign,
        datetime,
    }).toString();

    const response = await fetch(url);
    const { signature } = await response.json() as { signature: string };
    return signature;
};

const client = new S3Client({
    bucket: 'my-bucket',
    region: 'eu-west-1',
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID! },
    signer: createAwsSignerWithProvider(signatureProvider),
});
```

You can also provide a custom `Signer` directly. It receives `SignParams` and a limited `SignerConfig` (`bucket`, `region`, and optional `credentials`) and returns a `SignResult` containing the signed `url` and `headers`.

## Retries and errors

Requests retry retryable failures by default, including fetch network errors and service errors with HTTP status 408, 429, or 500 and above. A service-specific `retryable` value can override the status-based decision. The default is two retries after the first attempt, with full jitter and an initial backoff ceiling of 500 ms that doubles on each retry. A `Retry-After` value is honored, subject to `maxRetryAfter`.

| `RetryOptions` property | Default | Description |
| --- | --- | --- |
| `limit` | 2 | Maximum retries after the first attempt. |
| `baseDelay` | 500 ms | Initial backoff ceiling; doubles for each retry. |
| `backoffLimit` | No finite cap | Maximum exponential-backoff ceiling. |
| `maxRetryAfter` | No finite cap | Longest `Retry-After` delay to wait before failing instead. |

Override only the retry settings you need:

```ts
const client = new S3Client({
    bucket: 'my-bucket',
    region: 'eu-west-1',
    signer: createAwsSigner(),
    retry: {
        limit: 4,
        baseDelay: 250,
        backoffLimit: 5_000,
        maxRetryAfter: 30_000,
    },
});
```

All retry delays and `Retry-After` limits are in milliseconds. `limit` is the number of retries after the initial attempt.

Failed S3 responses reject with `ServiceError`, which exposes `status`, `code`, `requestId`, `retryAfter` (milliseconds, when provided), and `retryable`.

```ts
import { ServiceError } from 's3-client';

try {
    await client.download('missing.txt');
} catch (error) {
    if (error instanceof ServiceError) {
        console.error(error.status, error.code, error.requestId);
    }
    throw error;
}
```
