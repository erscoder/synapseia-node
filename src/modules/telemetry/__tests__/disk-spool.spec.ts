import { mkdtempSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DiskSpool } from '../disk-spool';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'syn-tel-spool-'));
  const file = join(dir, 'spool.ndjson');
  return {
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('DiskSpool', () => {
  it('appends events and reads them back via drainHead', () => {
    const { file, cleanup } = tmp();
    try {
      const spool = new DiskSpool({ filePath: file });
      const events = [
        { id: 'a', message: 'one' },
        { id: 'b', message: 'two' },
      ];
      expect(spool.appendEvents(events)).toBe(true);
      const drained = spool.drainHead(10);
      expect(drained).toEqual(events);
      // After drain, file is empty.
      expect(spool.size()).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('drainHead respects the max param and leaves the tail behind', () => {
    const { file, cleanup } = tmp();
    try {
      const spool = new DiskSpool({ filePath: file });
      spool.appendEvents([
        { id: '1' },
        { id: '2' },
        { id: '3' },
        { id: '4' },
      ]);
      const first = spool.drainHead(2);
      expect(first.map((e: { id: string }) => e.id)).toEqual(['1', '2']);
      const second = spool.drainHead(10);
      expect(second.map((e: { id: string }) => e.id)).toEqual(['3', '4']);
    } finally {
      cleanup();
    }
  });

  it('skips malformed lines without losing the well-formed ones', () => {
    const { file, cleanup } = tmp();
    try {
      const spool = new DiskSpool({ filePath: file });
      spool.appendEvents([{ id: 'good' }]);
      // Append a corrupt line manually
      const fs = require('fs') as typeof import('fs');
      fs.appendFileSync(file, 'this is not json\n', 'utf8');
      spool.appendEvents([{ id: 'good2' }]);

      const drained = spool.drainHead(10);
      expect(drained.map((e: { id: string }) => e.id)).toEqual(['good', 'good2']);
    } finally {
      cleanup();
    }
  });

  it('truncates the head when over the cap', () => {
    const { file, cleanup } = tmp();
    try {
      const cap = 1024; // 1 KB cap
      const spool = new DiskSpool({ filePath: file, capBytes: cap });
      // Each event ~120 bytes once serialized — push enough to exceed.
      const many = Array.from({ length: 50 }, (_, i) => ({
        id: `evt_${i}`,
        body: 'A'.repeat(80),
      }));
      spool.appendEvents(many);
      const size = statSync(file).size;
      // After enforceCap the file should be at most cap (+ small line overhead)
      expect(size).toBeLessThanOrEqual(cap * 1.2);

      // Drain should still parse cleanly — survivors are the most recent.
      const drained = spool.drainHead(50) as Array<{ id: string }>;
      expect(drained.length).toBeGreaterThan(0);
      // Earliest events were dropped: we should not see evt_0.
      expect(drained.find(e => e.id === 'evt_0')).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('drainHead on an empty/missing file returns []', () => {
    const { file, cleanup } = tmp();
    try {
      const spool = new DiskSpool({ filePath: file });
      expect(spool.drainHead(10)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('appendEvents([]) is a no-op and returns true', () => {
    const { file, cleanup } = tmp();
    try {
      const spool = new DiskSpool({ filePath: file });
      expect(spool.appendEvents([])).toBe(true);
      expect(spool.size()).toBe(0);
    } finally {
      cleanup();
    }
  });
});
