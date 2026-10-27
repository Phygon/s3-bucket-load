/** HTTP methods supported by the signer. */
export type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD';

/** AWS credentials made available to a signer. */
export type Credentials = {
    /** AWS access key ID. */
    accessKeyId: string;
    /** Secret key, required by the local AWS signer. */
    secretAccessKey?: string;
    /** Session token for temporary AWS credentials. */
    sessionToken?: string;
};

/** Optional settings for request signing. */
export type SignOptions = {
    /** Presigned URL expiry in seconds, when supported by the signer. */
    expires?: number;
    /** Put the signature in the URL instead of signing request headers. */
    signQuery?: boolean;
};

/** Request details passed to a signer. */
export type SignParams = SignOptions & {
    /** URL to sign. */
    url: string;
    /** HTTP method; defaults to `GET` in the AWS signer. */
    method?: HttpMethod;
    /** Request headers to include in signing. */
    headers?: Record<string, string> | Headers;
};

/** Signed URL and headers returned by a signer. */
export type SignResult = {
    /** Signed request URL, including query signature when presigning. */
    url: string;
    /** Signed headers to send with the request. */
    headers: Record<string, string> | Headers;
};

/** The limited client configuration exposed to the signer. */
export type SignerConfig = {
    /** Bucket being accessed. */
    bucket: string;
    /** Resolved signing region. */
    region: string;
    /** Credentials available to the signer. */
    credentials?: Credentials;
};

/** Signs requests or creates presigned URLs; remote implementations may call a signing service. */
export type Signer = (params: SignParams, config: SignerConfig) => Promise<SignResult>;
