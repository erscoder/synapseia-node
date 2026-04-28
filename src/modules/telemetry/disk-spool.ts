/**
 * Disk spool — append-only NDJSON file used to persist telemetry events
 * across restarts and during long coordinator outages. Reads / writes
 * happen rarely (only when the in-memory ring overflows or every
 * flush attempt fails), so simple synchronous fs is acceptable.
 *
 * Layout:
 *   ~/.synapseia/telemetry-spool.ndjson
 *
 * Cap: 50 MB. Beyond the cap we truncate the oldest 25% of bytes
 * (just rewrite-with-tail). Single file — no rotation. The whole
 * structure is best-effort: if disk fails, the spool is bypassed
 * and events return to RAM ring (where they'll be dropped on
 * overflow rather than crash the node).
 */

import { existsSync, mkdirSync, statSync } from 'fs';
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DEFAULT_SPOOL_DIR = join(homedir(), '.synapseia');
const DEFAULT_SPOOL_FILE = 'telemetry-spool.ndjson';
const SPOOL_CAP_BYTES = 50 * 1024 * 1024; // 50 MB
const SPOOL_TRUNCATE_RATIO = 0.25; // drop oldest 25% on overflow

export interface DiskSpoolOptions {
  /** Override for tests. Defaults to ~/.synapseia/telemetry-spool.ndjson. */
  filePath?: string;
  capBytes?: number;
}

export class DiskSpool {
  private readonly filePath: string;
  private readonly capBytes: number;

  constructor(opts: DiskSpoolOptions = {}) {
    this.filePath =
      opts.filePath ?? join(DEFAULT_SPOOL_DIR, DEFAULT_SPOOL_FILE);
    this.capBytes = opts.capBytes ?? SPOOL_CAP_BYTES;
  }

  get path(): string {
    return this.filePath;
  }

  /** Append events as NDJSON. Best-effort — failures are swallowed. */
  appendEvents(events: object[]): boolean {
    if (events.length === 0) return true;
    try {
      this.ensureFile();
      const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
      appendFileSync(this.filePath, lines, 'utf8');
      this.enforceCap();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Drain up to `max` events from the head of the file. The drained
   * events are removed (file is rewritten with the tail).
   *
   * Returns parsed events. Lines that fail to parse are silently
   * skipped (preferring forward progress over loop-ageing).
   */
  drainHead(max: number): object[] {
    if (!existsSync(this.filePath)) return [];
    let content: string;
    try {
      content = readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    if (!content) return [];

    const lines = content.split('\n').filter(l => l.length > 0);
    const head = lines.slice(0, max);
    const tail = lines.slice(max);

    const events: object[] = [];
    for (const line of head) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Bad line — skip. Don't put it back.
      }
    }

    try {
      writeFileSync(
        this.filePath,
        tail.length > 0 ? tail.join('\n') + '\n' : '',
        'utf8',
      );
    } catch {
      // Couldn't write back — we still return what we read; the next
      // run will re-drain the same prefix (idempotent on the server
      // via clientEventId, so no harm).
    }
    return events;
  }

  /** Current file size in bytes (0 if missing). */
  size(): number {
    try {
      return statSync(this.filePath).size;
    } catch {
      return 0;
    }
  }

  private ensureFile(): void {
    const dir = this.filePath.replace(/\/[^\/]*$/, '');
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(this.filePath)) {
      writeFileSync(this.filePath, '', 'utf8');
    }
  }

  private enforceCap(): void {
    const size = this.size();
    if (size <= this.capBytes) return;
    try {
      const content = readFileSync(this.filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.length > 0);
      // Drop oldest lines iteratively until under the cap (with a
      // small headroom so we don't bounce on the next append). The
      // 25% ratio is the *minimum* drop — keep going if the file is
      // still oversized after that.
      let dropCount = Math.max(
        1,
        Math.ceil(lines.length * SPOOL_TRUNCATE_RATIO),
      );
      const headroom = Math.floor(this.capBytes * 0.9);
      let kept = lines.slice(dropCount);
      let bytes = kept.reduce((a, l) => a + Buffer.byteLength(l, 'utf8') + 1, 0);
      while (bytes > headroom && kept.length > 0) {
        kept = kept.slice(1);
        bytes -= Buffer.byteLength(lines[dropCount++], 'utf8') + 1;
      }
      writeFileSync(
        this.filePath,
        kept.length > 0 ? kept.join('\n') + '\n' : '',
        'utf8',
      );
    } catch {
      // If even truncation fails, accept the bloat — beats data loss.
    }
  }
}

export const SPOOL_LIMITS = { SPOOL_CAP_BYTES, SPOOL_TRUNCATE_RATIO };
