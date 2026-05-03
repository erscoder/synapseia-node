/**
 * Plan D.4-distribution.4 — node-side append-only on-disk store for
 * per-shard snapshot records. Persists at
 * `<nodeHome>/shards/shard-<id>.bin`. The frame format is identical to
 * the wire codec (`[uint32 LE length][JSON bytes]`) so the same parser
 * reads it on boot and the snapshot stream writes it as it arrives.
 *
 * Memory `feedback_node_no_db`: zero TypeORM / pg drivers. We only
 * touch the local filesystem.
 *
 * Atomicity: an in-progress sync writes to `<id>.bin.tmp` and renames
 * to `<id>.bin` on `commit(total)`. A crash mid-sync leaves the `.tmp`
 * file behind; the next `openSync` deletes it before opening fresh.
 *
 * Memory `feedback_logger`: every log line goes through the project
 * logger.
 */

import { promises as fsp, existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import logger from '../../utils/logger';

export interface SnapshotRecord {
  embeddingId: string;
  shardId: number;
  vector: number[];
  sourceType: string;
  sourceId: string;
  domain: string;
  evidenceLevel: string | null;
  createdAtMs: number;
}

export interface IKgShardStorage {
  /** Open a write session for an in-progress sync. Returns a handle
   *  whose `commit(total)` atomically promotes the temp file. */
  openSync(shardId: number): Promise<{
    write(record: SnapshotRecord): Promise<void>;
    commit(total: number): Promise<void>;
    abort(): Promise<void>;
  }>;
  /** Append a single record to an existing shard file (delta path). */
  appendOne(shardId: number, record: SnapshotRecord): Promise<void>;
  /** Append N records in a single open/write/close cycle. Amortises
   *  the per-call fsync overhead — used by the delta handler when a
   *  batched envelope arrives. Reviewer item #7. */
  appendMany(shardId: number, records: SnapshotRecord[]): Promise<void>;
  /** Stream every persisted record for `shardId` to `onRecord`. Returns
   *  total records seen. */
  read(shardId: number, onRecord: (r: SnapshotRecord) => void): Promise<number>;
  /** True iff the shard's `.bin` file exists. */
  exists(shardId: number): boolean;
  /** Number of records currently persisted. Walks the file. */
  count(shardId: number): Promise<number>;
  /** Path the writer/reader uses (test introspection). */
  pathFor(shardId: number): string;
}

const SHARDS_SUBDIR = 'shards';
const MAX_FRAME_BYTES = 1 << 20; // mirror codec cap

function frameFor(record: SnapshotRecord): Buffer {
  const json = Buffer.from(JSON.stringify(record), 'utf8');
  if (json.byteLength > MAX_FRAME_BYTES) {
    throw new Error(`KgShardStorage: record size ${json.byteLength} > ${MAX_FRAME_BYTES}`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.byteLength, 0);
  return Buffer.concat([header, json]);
}

export class KgShardStorage implements IKgShardStorage {
  private readonly shardsDir: string;

  constructor(private readonly nodeHome: string) {
    this.shardsDir = path.join(nodeHome, SHARDS_SUBDIR);
  }

  pathFor(shardId: number): string {
    return path.join(this.shardsDir, `shard-${shardId}.bin`);
  }

  private tempPathFor(shardId: number): string {
    return path.join(this.shardsDir, `shard-${shardId}.bin.tmp`);
  }

  exists(shardId: number): boolean {
    return existsSync(this.pathFor(shardId));
  }

  async openSync(shardId: number): Promise<{
    write(record: SnapshotRecord): Promise<void>;
    commit(total: number): Promise<void>;
    abort(): Promise<void>;
  }> {
    mkdirSync(this.shardsDir, { recursive: true, mode: 0o700 });

    const tmpPath = this.tempPathFor(shardId);
    // Drop any stale temp from a previous crashed sync.
    try { await fsp.unlink(tmpPath); } catch { /* ignore */ }

    const handle = await fsp.open(tmpPath, 'w', 0o600);
    let written = 0;
    let closed = false;

    return {
      write: async (record: SnapshotRecord): Promise<void> => {
        if (closed) throw new Error('KgShardStorage: write after commit/abort');
        await handle.write(frameFor(record));
        written++;
      },
      commit: async (total: number): Promise<void> => {
        if (closed) return;
        closed = true;
        try {
          await handle.sync();
        } catch { /* fdatasync may not be supported on every fs */ }
        await handle.close();
        await fsp.rename(tmpPath, this.pathFor(shardId));
        logger.log(
          `[kg-shard-storage] committed shard=${shardId} records=${total} (written=${written})`,
        );
      },
      abort: async (): Promise<void> => {
        if (closed) return;
        closed = true;
        try { await handle.close(); } catch { /* ignore */ }
        try { await fsp.unlink(tmpPath); } catch { /* ignore */ }
        logger.warn(`[kg-shard-storage] aborted shard=${shardId} (written=${written}, tmp removed)`);
      },
    };
  }

  async appendOne(shardId: number, record: SnapshotRecord): Promise<void> {
    return this.appendMany(shardId, [record]);
  }

  async appendMany(shardId: number, records: SnapshotRecord[]): Promise<void> {
    if (records.length === 0) return;
    mkdirSync(this.shardsDir, { recursive: true, mode: 0o700 });
    const handle = await fsp.open(this.pathFor(shardId), 'a', 0o600);
    try {
      // One concatenated write per batch — kernel-side this lands as
      // a single contiguous append. Reviewer item #7.
      const frames: Buffer[] = records.map(frameFor);
      await handle.write(Buffer.concat(frames));
    } finally {
      await handle.close();
    }
  }

  async read(
    shardId: number,
    onRecord: (r: SnapshotRecord) => void,
  ): Promise<number> {
    const filePath = this.pathFor(shardId);
    if (!existsSync(filePath)) return 0;
    const buf = await fsp.readFile(filePath);
    let pos = 0;
    let count = 0;
    while (pos + 4 <= buf.byteLength) {
      const len = buf.readUInt32LE(pos);
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`KgShardStorage: frame ${len} > ${MAX_FRAME_BYTES} at offset ${pos}`);
      }
      if (pos + 4 + len > buf.byteLength) {
        // Trailing partial frame (e.g. crashed mid-write); stop and warn.
        logger.warn(
          `[kg-shard-storage] partial trailing frame at offset ${pos} in shard=${shardId} (read ${count} records)`,
        );
        break;
      }
      const slice = buf.subarray(pos + 4, pos + 4 + len);
      onRecord(JSON.parse(slice.toString('utf8')) as SnapshotRecord);
      pos += 4 + len;
      count++;
    }
    return count;
  }

  async count(shardId: number): Promise<number> {
    let n = 0;
    await this.read(shardId, () => { n++; });
    return n;
  }
}
