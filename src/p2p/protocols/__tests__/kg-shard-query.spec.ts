/**
 * Tests for the `/synapseia/kg-shard-query/1.0.0` libp2p stream
 * handler.
 *
 * Plan D.4.
 */
import {
  type IKgShardSearcher,
  type KgShardQueryRequest,
  makeKgShardQueryHandler,
  StubKgShardSearcher,
} from '../kg-shard-query';
import { KgShardOwnershipStore } from '../../kg-shard/KgShardOwnershipStore';

class MockStream {
  public sunk: Uint8Array[] = [];
  public writeClosed = false;
  constructor(private feed: Uint8Array[] = []) {}
  send(chunk: Uint8Array): boolean {
    this.sunk.push(chunk);
    return true;
  }
  async closeWrite(): Promise<void> {
    this.writeClosed = true;
  }
  addEventListener(): void { /* unused */ }
  removeEventListener(): void { /* unused */ }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    const feed = this.feed;
    let i = 0;
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        if (i >= feed.length) return { value: undefined as unknown as Uint8Array, done: true };
        return { value: feed[i++], done: false };
      },
    };
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
  parseSentJson<T>(): T {
    const all = this.sunkBytes();
    const len = new DataView(all.buffer, all.byteOffset, 4).getUint32(0, true);
    return JSON.parse(new TextDecoder().decode(all.subarray(4, 4 + len))) as T;
  }
}

function framed(obj: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const out = new Uint8Array(4 + json.byteLength);
  new DataView(out.buffer).setUint32(0, json.byteLength, true);
  out.set(json, 4);
  return out;
}

describe('kg-shard-query handler', () => {
  const NOW = 1_700_000_000_000;
  let store: KgShardOwnershipStore;

  beforeEach(() => {
    store = new KgShardOwnershipStore(() => NOW);
  });

  it('returns NOT_AUTHORIZED when the shard is not held', async () => {
    const handler = makeKgShardQueryHandler({ store });
    const req: KgShardQueryRequest = {
      shardId: 1,
      embedding: null,
      query: 'hello',
      k: 5,
    };
    const stream = new MockStream([framed(req)]);
    await handler(stream, {});
    const reply = stream.parseSentJson<{ error: string }>();
    expect(reply.error).toBe('NOT_AUTHORIZED');
  });

  it('returns the searcher hits when the shard is held', async () => {
    store.set(7, NOW + 60_000);
    const searcher: IKgShardSearcher = {
      search: jest.fn().mockResolvedValue([
        { id: 'd1', score: 0.9, title: 'Discovery 1' },
      ]),
    };
    const handler = makeKgShardQueryHandler({ store, searcher });
    const req: KgShardQueryRequest = {
      shardId: 7,
      embedding: [0.1, 0.2, 0.3],
      query: null,
      k: 3,
    };
    const stream = new MockStream([framed(req)]);
    await handler(stream, {});

    const reply = stream.parseSentJson<{
      ok: boolean;
      shardId: number;
      hits: unknown[];
    }>();
    expect(reply.ok).toBe(true);
    expect(reply.shardId).toBe(7);
    expect(reply.hits).toHaveLength(1);
    expect(searcher.search).toHaveBeenCalledTimes(1);
  });

  it('falls back to the stub searcher and returns empty hits when none provided', async () => {
    store.set(0, NOW + 60_000);
    const handler = makeKgShardQueryHandler({ store });
    const req: KgShardQueryRequest = {
      shardId: 0,
      embedding: null,
      query: 'x',
      k: 5,
    };
    const stream = new MockStream([framed(req)]);
    await handler(stream, {});

    const reply = stream.parseSentJson<{ ok: boolean; hits: unknown[] }>();
    expect(reply.ok).toBe(true);
    expect(reply.hits).toEqual([]);
  });

  it('returns BAD_REQUEST for malformed payloads', async () => {
    store.set(0, NOW + 60_000);
    const handler = makeKgShardQueryHandler({ store });
    // missing both `embedding` and `query`
    const stream = new MockStream([framed({ shardId: 0, k: 1, embedding: null, query: null })]);
    await handler(stream, {});
    const reply = stream.parseSentJson<{ error: string }>();
    expect(reply.error).toBe('BAD_REQUEST');
  });

  it('returns INTERNAL when the searcher throws', async () => {
    store.set(0, NOW + 60_000);
    const searcher: IKgShardSearcher = {
      search: jest.fn().mockRejectedValue(new Error('hnsw exploded')),
    };
    const handler = makeKgShardQueryHandler({ store, searcher });
    const stream = new MockStream([framed({
      shardId: 0,
      embedding: null,
      query: 'x',
      k: 1,
    })]);
    await handler(stream, {});
    const reply = stream.parseSentJson<{ error: string }>();
    expect(reply.error).toBe('INTERNAL');
  });

  it('StubKgShardSearcher returns empty hits', async () => {
    const stub = new StubKgShardSearcher();
    expect(
      await stub.search({ shardId: 0, embedding: null, query: 'x', k: 1 }),
    ).toEqual([]);
  });
});
