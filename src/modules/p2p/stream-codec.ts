/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimal length-prefixed JSON codec over libp2p streams. No deps.
 *
 * Mirror of `packages/coordinator/src/infrastructure/p2p/stream-codec.ts` —
 * a parity test in each package keeps the wire format byte-for-byte
 * identical. If either copy changes, both tests fail together.
 *
 * Frame format: `[uint32 LE length][JSON bytes]`. One JSON object per frame;
 * caller sends request frame, receives response frame, then closes.
 */

const MAX_FRAME_BYTES = 1 << 20; // 1 MB

export async function sendJsonOverStream(
  stream: any,
  obj: unknown,
): Promise<void> {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  if (json.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`stream-codec: payload ${json.byteLength} > ${MAX_FRAME_BYTES}`);
  }
  const header = new Uint8Array(4);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, json.byteLength, true);
  const full = new Uint8Array(4 + json.byteLength);
  full.set(header, 0);
  full.set(json, 4);
  async function* once() {
    yield full;
  }
  await stream.sink(once());
}

export async function readJsonFromStream<T = unknown>(stream: any): Promise<T> {
  const source = stream.source as AsyncIterable<Uint8Array | { subarray(): Uint8Array }>;
  const buffers: Uint8Array[] = [];
  let total = 0;
  let expected: number | null = null;

  for await (const chunk of source) {
    const bytes = chunk instanceof Uint8Array ? chunk : (chunk as any).subarray();
    buffers.push(bytes);
    total += bytes.byteLength;
    if (expected === null && total >= 4) {
      const head = coalesceFirstN(buffers, 4);
      const dv = new DataView(head.buffer, head.byteOffset, 4);
      expected = dv.getUint32(0, true);
      if (expected > MAX_FRAME_BYTES) {
        throw new Error(`stream-codec: frame length ${expected} > ${MAX_FRAME_BYTES}`);
      }
    }
    if (expected !== null && total >= 4 + expected) break;
  }

  if (expected === null) throw new Error('stream-codec: stream ended before header');
  const all = coalesce(buffers);
  if (all.byteLength < 4 + expected) {
    throw new Error(`stream-codec: stream ended mid-frame (got ${all.byteLength - 4} of ${expected})`);
  }
  const payload = all.subarray(4, 4 + expected);
  const text = new TextDecoder().decode(payload);
  return JSON.parse(text) as T;
}

function coalesce(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function coalesceFirstN(chunks: Uint8Array[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    if (off >= n) break;
    const take = Math.min(c.byteLength, n - off);
    out.set(c.subarray(0, take), off);
    off += take;
  }
  return out;
}
