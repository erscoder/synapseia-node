import { sendJsonOverStream, readJsonFromStream } from '../stream-codec';

/**
 * Mirror of the coordinator's stream-codec.spec.ts. The parity vector at
 * the bottom must match byte-for-byte to guarantee the two copies speak the
 * same wire format.
 */

class MockDuplexStream {
  public sunk: Uint8Array[] = [];
  constructor(private feed: Uint8Array[] = []) {}
  async sink(it: AsyncIterable<Uint8Array>) {
    for await (const chunk of it) this.sunk.push(chunk);
  }
  get source() {
    const feed = this.feed;
    return (async function* () {
      for (const c of feed) yield c;
    })();
  }
  sunkBytes(): Uint8Array {
    let total = 0;
    for (const c of this.sunk) total += c.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.sunk) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }
}

function framed(obj: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(4 + json.byteLength);
  new DataView(out.buffer).setUint32(0, json.byteLength, true);
  out.set(json, 4);
  return out;
}

describe('stream-codec (node)', () => {
  it('send + read round-trip', async () => {
    const obj = { hello: 'world', n: 42 };
    const s1 = new MockDuplexStream();
    await sendJsonOverStream(s1, obj);
    const s2 = new MockDuplexStream([s1.sunkBytes()]);
    expect(await readJsonFromStream(s2)).toEqual(obj);
  });

  it('read copes with a frame split across 3 chunks', async () => {
    const full = framed({ split: 'three' });
    const a = full.subarray(0, 2);
    const b = full.subarray(2, 5);
    const c = full.subarray(5);
    const stream = new MockDuplexStream([a, b, c]);
    expect(await readJsonFromStream(stream)).toEqual({ split: 'three' });
  });

  it('read throws on oversized frame', async () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, (1 << 20) + 1, true);
    await expect(readJsonFromStream(new MockDuplexStream([header]))).rejects.toThrow(/frame length/);
  });
});

describe('stream-codec parity vector (coordinator ↔ node)', () => {
  const hex = (buf: Uint8Array): string =>
    Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');

  it('frames {"ping":1} as the canonical byte sequence', async () => {
    const stream = new MockDuplexStream();
    await sendJsonOverStream(stream, { ping: 1 });
    expect(hex(stream.sunkBytes())).toBe('0a0000007b2270696e67223a317d');
  });
});
