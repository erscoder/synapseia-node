/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimal length-prefixed JSON codec over libp2p v3 streams. No deps.
 *
 * Mirror of `packages/coordinator/src/infrastructure/p2p/stream-codec.ts` —
 * a parity test in each package keeps the wire format byte-for-byte
 * identical. If either copy changes, both tests fail together.
 *
 * Frame format: `[uint32 LE length][JSON bytes]`. One JSON object per frame;
 * caller sends request frame, receives response frame, then closes.
 *
 * libp2p v3 Stream API — the old sink/source pull-stream pattern is gone.
 * Use `stream.send(bytes)` / `for await (const chunk of stream)` /
 * `stream.closeWrite()`. Trying `stream.sink(...)` throws
 * `stream.sink is not a function` and the chat stream dies.
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
  const full = new Uint8Array(4 + json.byteLength);
  new DataView(full.buffer, full.byteOffset, 4).setUint32(0, json.byteLength, true);
  full.set(json, 4);

  const ok = stream.send(full);
  if (!ok) {
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => { cleanup(); resolve(); };
      const onClose = (): void => { cleanup(); reject(new Error('stream closed before drain')); };
      const cleanup = (): void => {
        stream.removeEventListener?.('drain', onDrain);
        stream.removeEventListener?.('close', onClose);
        stream.removeEventListener?.('remoteCloseRead', onClose);
      };
      stream.addEventListener?.('drain', onDrain, { once: true });
      stream.addEventListener?.('close', onClose, { once: true });
      stream.addEventListener?.('remoteCloseRead', onClose, { once: true });
    });
  }

  // Signal EOF on our writable half so the peer's read loop terminates.
  try { await stream.closeWrite?.(); } catch { /* ignore */ }
}

export async function readJsonFromStream<T = unknown>(stream: any): Promise<T> {
  const buffers: Uint8Array[] = [];
  let total = 0;
  let expected: number | null = null;

  for await (const chunk of stream as AsyncIterable<Uint8Array | { subarray(start?: number, end?: number): Uint8Array }>) {
    const bytes = chunk instanceof Uint8Array ? chunk : (chunk as any).subarray();
    buffers.push(bytes);
    total += bytes.byteLength;

    if (expected === null && total >= 4) {
      const head = coalesceFirstN(buffers, 4);
      expected = new DataView(head.buffer, head.byteOffset, 4).getUint32(0, true);
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
  return JSON.parse(new TextDecoder().decode(payload)) as T;
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
