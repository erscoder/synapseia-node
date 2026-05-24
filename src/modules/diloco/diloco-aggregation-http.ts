/**
 * Coord-mediated presigned-URL HTTP I/O for the DiLoCo node-side aggregation
 * executor (Phase 4). Replaces the former direct-S3 client
 * (`diloco-aggregation-s3.ts`) — the compute node has ZERO AWS credentials
 * (verified: pods carry 0/7 AWS env vars). Instead, the COORDINATOR (which
 * already holds S3 access) presigns:
 *   - a GET URL for every pinned input (gradient / prevAdapter / prevVelocity),
 *   - a PUT URL for each of this aggregator's two candidate keys,
 * and ships them in the WO payload. The node just does plain HTTP GET/PUT to
 * those URLs. This mirrors the training path (nodes upload gradients via the
 * coord, no node S3 creds).
 *
 * Fail-closed (P2): a non-2xx GET/PUT, an oversized body, or a missing body
 * throws `DiLoCoAggregationHttpError` — the runner aborts and never
 * aggregates / commits a partial result. The runner additionally
 * sha256-verifies the downloaded bytes against the pinned sha256 BEFORE use
 * (the URL only proves "the coord presigned this object", not that the bytes
 * are the pinned ones — integrity is the sha256 gate).
 *
 * No AWS SDK, no creds, no bucket config on the node.
 */
import axios, { type AxiosInstance } from 'axios';
import { createHash } from 'crypto';

export class DiLoCoAggregationHttpError extends Error {
  constructor(message: string, public readonly stage: string) {
    super(message);
    this.name = 'DiLoCoAggregationHttpError';
  }
}

/** Plain-HTTP presigned-URL transport the runner depends on (test seam). */
export interface DiLoCoAggregationHttpIO {
  /**
   * Download an object from a presigned GET URL into a Buffer, capped at
   * `maxBytes`. Throws on a non-2xx response, an oversized `Content-Length`,
   * or a body exceeding the cap mid-stream (a malformed / huge object would
   * blow RAM — the gradient is ~92 MB).
   */
  getUrl(url: string, maxBytes: number): Promise<Buffer>;
  /**
   * Upload a Buffer to a presigned PUT URL with the exact content-type the
   * coord signed (`application/octet-stream`) + correct `Content-Length`.
   * Throws on a non-2xx response (e.g. 403 SignatureDoesNotMatch on an
   * expired URL — P35).
   */
  putUrl(url: string, body: Buffer): Promise<void>;
}

/** Build the real axios-backed HTTP I/O. Always available — no env gate
 *  (the node needs no S3/AWS config; the presigned URL carries everything). */
export function createDiLoCoAggregationHttpIO(client?: AxiosInstance): DiLoCoAggregationHttpIO {
  const http = client ?? axios.create();
  return new RealDiLoCoAggregationHttpIO(http);
}

class RealDiLoCoAggregationHttpIO implements DiLoCoAggregationHttpIO {
  constructor(private readonly http: AxiosInstance) {}

  async getUrl(url: string, maxBytes: number): Promise<Buffer> {
    let res;
    try {
      res = await this.http.get(url, {
        responseType: 'arraybuffer',
        // Stream-safe cap: axios buffers the full body, so bound it. The
        // gradient is ~92 MB; reject anything larger BEFORE it lands in RAM
        // where the transport allows (axios enforces maxContentLength).
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        // We validate the status ourselves so a 403 (expired URL) surfaces a
        // typed error rather than an opaque axios throw.
        validateStatus: () => true,
      });
    } catch (err) {
      throw new DiLoCoAggregationHttpError(
        `HTTP GET (presigned) failed: ${(err as Error).message}`,
        'download',
      );
    }
    if (res.status < 200 || res.status >= 300) {
      // P2/P35 fail-closed — a 403/SignatureDoesNotMatch (expired URL) or any
      // non-2xx aborts; never aggregate from a failed download.
      throw new DiLoCoAggregationHttpError(
        `HTTP GET (presigned) returned ${res.status}`,
        'download',
      );
    }
    const buf = Buffer.from(res.data as ArrayBuffer);
    if (buf.length > maxBytes) {
      throw new DiLoCoAggregationHttpError(
        `Body exceeded cap (${buf.length} > ${maxBytes})`,
        'download',
      );
    }
    return buf;
  }

  async putUrl(url: string, body: Buffer): Promise<void> {
    let res;
    try {
      res = await this.http.put(url, body, {
        headers: {
          // MUST match the content-type the coord signed into the PUT URL,
          // else S3 returns SignatureDoesNotMatch.
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(body.length),
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      });
    } catch (err) {
      throw new DiLoCoAggregationHttpError(
        `HTTP PUT (presigned) failed: ${(err as Error).message}`,
        'upload',
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new DiLoCoAggregationHttpError(
        `HTTP PUT (presigned) returned ${res.status}`,
        'upload',
      );
    }
  }
}

/** Hex sha256 of a buffer (lowercase). */
export function sha256OfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
