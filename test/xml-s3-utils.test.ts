import { describe, expect, it } from 'vitest';
import { parseXml, buildXml } from '../src/xml.ts';
import {
    buildCompleteMultipartXml,
    bucketEndpoint,
    encodeObjectKey,
    parseS3Xml,
    sanitizeETag,
    s3ServiceError,
} from '../src/s3-utils.ts';
import { ServiceError } from '../src/service-error.ts';

describe('XML helpers', () => {
    it('returns the root name and value when parsing XML', () => {
        expect(parseXml<{ Value: string }>('<Result><Value>ok</Value></Result>')).toEqual({
            rootName: 'Result',
            value: { Value: 'ok' },
        });
    });

    it('returns undefined root and value for empty XML', () => {
        expect(parseXml('')).toEqual({ rootName: undefined, value: undefined });
    });

    it('escapes text while building XML', () => {
        const xml = buildXml({ Result: { Message: 'A&B <C>' } });
        expect(xml).toContain('A&amp;B');
        expect(xml).toContain('&lt;C&gt;');
    });
});

describe('encodeObjectKey', () => {
    it('encodes each segment but preserves slash separators', () => {
        expect(encodeObjectKey('folder/a b+c.txt')).toBe('folder/a%20b%2Bc.txt');
    });

    it('keeps a leading slash relative to the endpoint path', () => {
        expect(encodeObjectKey('/folder/file')).toBe('.//folder/file');
    });
});

describe('bucketEndpoint', () => {
    it('builds an AWS virtual-hosted endpoint', () => {
        expect(bucketEndpoint({ bucket: 'archive', region: 'eu-west-1' }))
            .toBe('https://archive.s3.eu-west-1.amazonaws.com/');
    });

    it('adds the bucket to a custom endpoint and removes its query and hash', () => {
        expect(bucketEndpoint({
            bucket: 'my bucket',
            region: 'auto',
            endpoint: 'https://s3.example.test/root/?mode=1#fragment',
        })).toBe('https://s3.example.test/root/my%20bucket/');
    });
});

describe('S3 XML and metadata helpers', () => {
    it('sanitizes quoted ETags and leaves unquoted values alone', () => {
        expect(sanitizeETag('"abc"')).toBe('abc');
        expect(sanitizeETag('abc')).toBe('abc');
        expect(sanitizeETag(null)).toBeUndefined();
    });

    it('sorts completion parts by part number and quotes ETags', () => {
        const xml = buildCompleteMultipartXml([
            { partNumber: 2, etag: 'etag-2' },
            { partNumber: 1, etag: 'etag-1' },
        ]);
        expect(xml.indexOf('<PartNumber>1</PartNumber>')).toBeLessThan(xml.indexOf('<PartNumber>2</PartNumber>'));
        expect(xml).toContain('<ETag>&quot;etag-1&quot;</ETag>');
    });

    it('returns a successful S3 XML root value', () => {
        expect(parseS3Xml<{ Value: string }>(
            '<Result><Value>ok</Value></Result>',
            200,
            new Headers(),
        )).toEqual({ Value: 'ok' });
    });

    it('throws ServiceError for an S3 Error XML body', () => {
        expect(() => parseS3Xml(
            '<Error><Code>AccessDenied</Code><Message>no</Message></Error>',
            403,
            new Headers(),
        )).toThrow(ServiceError);
    });

    it('throws when a successful XML response has no root value', () => {
        expect(() => parseS3Xml('', 200, new Headers())).toThrow('was empty');
    });

    it('extracts S3 error details and marks known transient codes retryable', () => {
        const error = s3ServiceError(
            503,
            new Headers({ 'x-amz-request-id': 'header-id' }),
            '<Error><Code>SlowDown</Code><Message>please wait</Message></Error>',
        );
        expect(error).toMatchObject({
            status: 503,
            code: 'SlowDown',
            message: 'please wait',
            requestId: 'header-id',
            retryable: true,
        });
    });
});
