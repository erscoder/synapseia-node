/**
 * Minimal S3 client for the DiLoCo node-side aggregation executor
 * (re-architecture Phase 3). The node shares the coordinator's DiLoCo
 * bucket (`AWS_DILOCO_BUCKET`); the WO ships bucket-relative S3 KEYS (not
 * URLs) for each pinned gradient + prevAdapter + prevVelocity, and the
 * coord later promotes the consensus-winning candidate via a SERVER-SIDE
 * `CopyObject` from the per-aggregator `candidates/<peerId>/` prefix
 * (`DiLoCoGradientStorageService.copyKeyToLatest` /
 * `promoteVelocity`). For that copy to work the node MUST physically PUT
 * the candidate object at that key — hence direct S3 access here, mirroring
 * the coord's client config (`getSharedS3Client`):
 *   - bucket   = `AWS_DILOCO_BUCKET`
 *   - region   = `AWS_REGION` (default `us-east-1`)
 *   - endpoint = `AWS_S3_ENDPOINT` (MinIO / LocalStack) → `forcePathStyle`
 *   - creds    = AWS SDK default chain (`AWS_ACCESS_KEY_ID` + secret +
 *                optional `AWS_SESSION_TOKEN`)
 *
 * Uploads set `ServerSideEncryption: AES256` + `Metadata.sha256` so the
 * candidate object matches the coord's gradient/adapter object convention
 * (the coord re-hashes the downloaded candidate for integrity; the next
 * round can pin velocity by `Metadata.sha256`).
 *
 * Gated entirely on `AWS_DILOCO_BUCKET`: when unset the executor refuses
 * to run (the WO is inert — Phase 4 flips the coord flag only once nodes
 * are configured). Fail-closed (P2): no silent local-disk fallback.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'crypto';

export class DiLoCoAggregationS3Error extends Error {
  constructor(message: string, public readonly stage: string) {
    super(message);
    this.name = 'DiLoCoAggregationS3Error';
  }
}

export interface DiLoCoAggregationS3 {
  readonly bucket: string;
  /** Download an object by bucket-relative key into a Buffer (capped). */
  getObject(key: string, maxBytes: number): Promise<Buffer>;
  /** Upload a Buffer to a bucket-relative key with sha256 metadata + SSE. */
  putObject(key: string, body: Buffer, sha256Hex: string): Promise<void>;
}

/** Build the real S3 client, or `null` when `AWS_DILOCO_BUCKET` is unset. */
export function createDiLoCoAggregationS3(): DiLoCoAggregationS3 | null {
  const bucket = process.env.AWS_DILOCO_BUCKET ?? '';
  if (!bucket) return null;

  const region = process.env.AWS_REGION ?? 'us-east-1';
  const endpoint = process.env.AWS_S3_ENDPOINT || undefined;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;

  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    ...(accessKeyId && secretAccessKey
      ? {
          credentials: {
            accessKeyId,
            secretAccessKey,
            ...(sessionToken ? { sessionToken } : {}),
          },
        }
      : {}),
  });

  return new RealDiLoCoAggregationS3(client, bucket);
}

class RealDiLoCoAggregationS3 implements DiLoCoAggregationS3 {
  constructor(
    private readonly client: S3Client,
    public readonly bucket: string,
  ) {}

  async getObject(key: string, maxBytes: number): Promise<Buffer> {
    let res;
    try {
      res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      throw new DiLoCoAggregationS3Error(
        `S3 GetObject failed key=${key}: ${(err as Error).message}`,
        'download',
      );
    }
    // Refuse oversized objects BEFORE buffering the whole body (the
    // gradient is ~92 MB; a malformed/huge object would blow RAM).
    const contentLength = Number(res.ContentLength ?? NaN);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new DiLoCoAggregationS3Error(
        `Refusing download: key=${key} ContentLength ${contentLength} > cap ${maxBytes}`,
        'download',
      );
    }
    const body = res.Body as AsyncIterable<Uint8Array> | undefined;
    if (!body || typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function') {
      throw new DiLoCoAggregationS3Error(`S3 GetObject returned no stream for key=${key}`, 'download');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      total += chunk.length;
      if (total > maxBytes) {
        throw new DiLoCoAggregationS3Error(
          `Body exceeded cap mid-stream (${total} > ${maxBytes}) key=${key}`,
          'download',
        );
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async putObject(key: string, body: Buffer, sha256Hex: string): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/octet-stream',
          ServerSideEncryption: 'AES256',
          Metadata: { sha256: sha256Hex },
        }),
      );
    } catch (err) {
      throw new DiLoCoAggregationS3Error(
        `S3 PutObject failed key=${key}: ${(err as Error).message}`,
        'upload',
      );
    }
  }
}

/** Hex sha256 of a buffer (lowercase). */
export function sha256OfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
