/**
 * NIT-1 — real axios HTTP transport for the coord-mediated presigned-URL
 * DiLoCo aggregation I/O (`RealDiLoCoAggregationHttpIO`).
 *
 * The runner tests inject a fake `httpIO` and ignore wire headers, so the
 * LITERAL axios request that actually hits S3 had zero coverage. This is the
 * #1 silent-breaker: a stray `Content-Type`/`x-amz-*` header on the PUT →
 * S3 `SignatureDoesNotMatch` (P35), an un-validated non-2xx → aggregating
 * from a failed download (P2 fail-closed).
 *
 * We exercise the REAL transport against a stub `AxiosInstance` (the
 * `createDiLoCoAggregationHttpIO(client?)` test seam) so we can assert the
 * EXACT outgoing request config (method, url, body, headers) and drive the
 * response (status / data / throw) deterministically — no network.
 */
import {
  createDiLoCoAggregationHttpIO,
  DiLoCoAggregationHttpError,
  type DiLoCoAggregationHttpIO,
} from '../diloco-aggregation-http';

/** A minimal axios-instance stub capturing the outgoing config and replaying
 *  a scripted response (or throwing a transport error). */
function makeAxiosStub() {
  const get = jest.fn();
  const put = jest.fn();
  // Cast through unknown — we only implement the two methods the transport
  // uses; `createDiLoCoAggregationHttpIO` accepts any AxiosInstance.
  const instance = { get, put } as unknown as Parameters<typeof createDiLoCoAggregationHttpIO>[0];
  return { instance, get, put };
}

const PUT_URL = 'https://s3.test/bucket/med/round_7/candidates/a/adapter_weights.pkl?X-Amz-Signature=deadbeef';
const GET_URL = 'https://s3.test/bucket/med/round_7/p1.pt?X-Amz-Signature=cafe';

describe('RealDiLoCoAggregationHttpIO.putUrl (NIT-1 — SignatureDoesNotMatch guard)', () => {
  let io: DiLoCoAggregationHttpIO;
  let put: jest.Mock;

  beforeEach(() => {
    const stub = makeAxiosStub();
    io = createDiLoCoAggregationHttpIO(stub.instance);
    put = stub.put;
  });

  it('sends EXACTLY Content-Type: application/octet-stream (no x-amz-*, no application/json)', async () => {
    put.mockResolvedValue({ status: 200, data: undefined });
    const body = Buffer.from('candidate-adapter-bytes');

    await io.putUrl(PUT_URL, body);

    expect(put).toHaveBeenCalledTimes(1);
    const [url, sentBody, config] = put.mock.calls[0];
    expect(url).toBe(PUT_URL);
    expect(sentBody).toBe(body);

    const headers = config.headers as Record<string, string>;
    // The whole point: S3 signed the PUT with content-type
    // `application/octet-stream`. Any deviation → SignatureDoesNotMatch.
    expect(headers['Content-Type']).toBe('application/octet-stream');

    // NO x-amz-* headers — those belong in the presigned URL's query string,
    // not the request headers; sending them re-signs the canonical request
    // and breaks the signature.
    const headerNames = Object.keys(headers).map((h) => h.toLowerCase());
    expect(headerNames.some((h) => h.startsWith('x-amz-'))).toBe(false);

    // Never application/json anywhere in the outgoing content-type.
    const allHeaderValues = Object.values(headers).join(' ').toLowerCase();
    expect(allHeaderValues).not.toContain('application/json');
  });

  it('sends the body buffer + the correct Content-Length', async () => {
    put.mockResolvedValue({ status: 204, data: undefined });
    const body = Buffer.from('a-larger-candidate-payload-0123456789');

    await io.putUrl(PUT_URL, body);

    const [, sentBody, config] = put.mock.calls[0];
    expect(Buffer.isBuffer(sentBody)).toBe(true);
    expect(sentBody).toBe(body);
    expect((config.headers as Record<string, string>)['Content-Length']).toBe(String(body.length));
  });

  it('resolves on a 2xx (200 and 204) without throwing', async () => {
    put.mockResolvedValueOnce({ status: 200, data: undefined });
    await expect(io.putUrl(PUT_URL, Buffer.from('x'))).resolves.toBeUndefined();
    put.mockResolvedValueOnce({ status: 204, data: undefined });
    await expect(io.putUrl(PUT_URL, Buffer.from('x'))).resolves.toBeUndefined();
  });

  it('throws (fail-closed) on a 403 SignatureDoesNotMatch / expired URL', async () => {
    // validateStatus is `() => true`, so a 403 surfaces as a resolved
    // response the transport itself rejects — NOT an axios throw.
    put.mockResolvedValue({ status: 403, data: Buffer.from('SignatureDoesNotMatch') });
    await expect(io.putUrl(PUT_URL, Buffer.from('x'))).rejects.toMatchObject({
      name: 'DiLoCoAggregationHttpError',
      stage: 'upload',
    });
    await expect(io.putUrl(PUT_URL, Buffer.from('x'))).rejects.toThrow(/returned 403/);
  });

  it('throws (fail-closed) on any non-2xx (500)', async () => {
    put.mockResolvedValue({ status: 500, data: undefined });
    await expect(io.putUrl(PUT_URL, Buffer.from('x'))).rejects.toBeInstanceOf(DiLoCoAggregationHttpError);
  });

  it('wraps a transport throw (network error) as a typed upload error', async () => {
    put.mockRejectedValue(new Error('ECONNRESET'));
    await expect(io.putUrl(PUT_URL, Buffer.from('x'))).rejects.toMatchObject({
      name: 'DiLoCoAggregationHttpError',
      stage: 'upload',
    });
    await expect(io.putUrl(PUT_URL, Buffer.from('x'))).rejects.toThrow(/ECONNRESET/);
  });
});

describe('RealDiLoCoAggregationHttpIO.getUrl', () => {
  let io: DiLoCoAggregationHttpIO;
  let get: jest.Mock;

  beforeEach(() => {
    const stub = makeAxiosStub();
    io = createDiLoCoAggregationHttpIO(stub.instance);
    get = stub.get;
  });

  it('returns the body bytes on a 2xx as a Buffer', async () => {
    const payload = Buffer.from('the-pinned-gradient-bytes');
    // axios with responseType 'arraybuffer' yields an ArrayBuffer-ish; the
    // transport does `Buffer.from(res.data)`.
    get.mockResolvedValue({ status: 200, data: payload });

    const out = await io.getUrl(GET_URL, 1_000_000);

    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(payload)).toBe(true);
  });

  it('requests arraybuffer + passes maxContentLength === maxBytes (RAM cap)', async () => {
    get.mockResolvedValue({ status: 200, data: Buffer.from('x') });
    const maxBytes = 92 * 1024 * 1024; // ~gradient size

    await io.getUrl(GET_URL, maxBytes);

    const [url, config] = get.mock.calls[0];
    expect(url).toBe(GET_URL);
    expect(config.responseType).toBe('arraybuffer');
    expect(config.maxContentLength).toBe(maxBytes);
    expect(config.maxBodyLength).toBe(maxBytes);
  });

  it('throws (fail-closed) on a 403 expired URL', async () => {
    get.mockResolvedValue({ status: 403, data: Buffer.from('SignatureDoesNotMatch') });
    await expect(io.getUrl(GET_URL, 1_000)).rejects.toMatchObject({
      name: 'DiLoCoAggregationHttpError',
      stage: 'download',
    });
    await expect(io.getUrl(GET_URL, 1_000)).rejects.toThrow(/returned 403/);
  });

  it('throws (fail-closed) on any non-2xx (404 / 500)', async () => {
    get.mockResolvedValueOnce({ status: 404, data: undefined });
    await expect(io.getUrl(GET_URL, 1_000)).rejects.toBeInstanceOf(DiLoCoAggregationHttpError);
    get.mockResolvedValueOnce({ status: 500, data: undefined });
    await expect(io.getUrl(GET_URL, 1_000)).rejects.toBeInstanceOf(DiLoCoAggregationHttpError);
  });

  it('throws when the body exceeds the cap mid-stream (downloaded bytes > maxBytes)', async () => {
    // Transport set maxContentLength on axios, but it ALSO re-checks the
    // materialised buffer length as a belt-and-suspenders guard.
    const big = Buffer.alloc(2048, 0x41);
    get.mockResolvedValue({ status: 200, data: big });
    await expect(io.getUrl(GET_URL, 1024)).rejects.toMatchObject({
      name: 'DiLoCoAggregationHttpError',
      stage: 'download',
    });
    await expect(io.getUrl(GET_URL, 1024)).rejects.toThrow(/exceeded cap/);
  });

  it('wraps a transport throw (network error) as a typed download error', async () => {
    get.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(io.getUrl(GET_URL, 1_000)).rejects.toMatchObject({
      name: 'DiLoCoAggregationHttpError',
      stage: 'download',
    });
  });
});
