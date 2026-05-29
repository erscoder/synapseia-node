// Mock for @noble/hashes — provides SHA256 and other hash functions
// Jest cannot parse noble's ESM, so we replace with Node's crypto

import { createHash } from 'crypto';

export const sha256 = (data: Uint8Array | string): Uint8Array => {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return new Uint8Array(createHash('sha256').update(buf).digest());
};

export const sha512 = (data: Uint8Array | string): Uint8Array => {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return new Uint8Array(createHash('sha512').update(buf).digest());
};

// HMAC backed by Node's real crypto (HMAC-SHA256) instead of a
// zero-filled digest. The previous mock returned new Uint8Array(32)
// (all zeros) and IGNORED both the key and the updated data, so any test
// that relied on @noble's hmac silently passed against a constant —
// a vacuous-crypto landmine. We key on the bytes passed to `create`
// (when present) and digest the accumulated updates, producing a real,
// input-dependent 32-byte MAC.
//
// @noble exposes hmac BOTH as a one-shot `hmac(hashCtor, key, message)`
// and as a streaming `hmac.create(hashCtor, key)`. Support both. The
// concrete hash algorithm is derived from output expectations; @noble's
// callers here use SHA-256-based HMAC.
type NobleHmac = {
  (hashCtor: unknown, key: Uint8Array, message: Uint8Array): Uint8Array;
  create: (
    hashCtor?: unknown,
    key?: Uint8Array,
  ) => { update: (data: Uint8Array) => unknown; digest: () => Uint8Array };
};

const hmacImpl = ((
  _hashCtor: unknown,
  key: Uint8Array,
  message: Uint8Array,
): Uint8Array => {
  const { createHmac } = require('crypto') as typeof import('crypto');
  return new Uint8Array(
    createHmac('sha256', Buffer.from(key ?? new Uint8Array(0)))
      .update(Buffer.from(message ?? new Uint8Array(0)))
      .digest(),
  );
}) as NobleHmac;

hmacImpl.create = (_hashCtor?: unknown, key?: Uint8Array) => {
  const { createHmac } = require('crypto') as typeof import('crypto');
  const h = createHmac('sha256', Buffer.from(key ?? new Uint8Array(0)));
  const wrapper = {
    update(data: Uint8Array) {
      h.update(Buffer.from(data));
      return wrapper;
    },
    digest(): Uint8Array {
      return new Uint8Array(h.digest());
    },
  };
  return wrapper;
};

export const hmac = hmacImpl;

export const randomBytes = (bytes: number): Uint8Array => {
  const { randomBytes: rb } = require('crypto') as typeof import('crypto');
  return new Uint8Array(rb(bytes));
};

// @noble/hashes/utils helpers used transitively by @solana/web3.js. Without
// these the mock load fails with "(0, utils_ts_1.utf8ToBytes) is not a
// function" and breaks any spec that imports a Solana service.
export const utf8ToBytes = (s: string): Uint8Array =>
  new Uint8Array(Buffer.from(s, 'utf8'));

export const bytesToHex = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('hex');

export const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return new Uint8Array(Buffer.from(clean, 'hex'));
};

export const concatBytes = (...arrs: Uint8Array[]): Uint8Array => {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
};

export const bytesToUtf8 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('utf8');

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  Buffer.from(a).equals(Buffer.from(b));

export const isBytes = (a: unknown): boolean => a instanceof Uint8Array;

export const toBytes = utf8ToBytes;

// @noble/hashes v2 utils — full surface needed by @solana/web3.js so we
// don't whack-a-mole each missing helper. These are no-op assertion-style
// validators (a*) and view helpers; tests don't depend on their checks.
export const anumber = (_n: number, _title?: string): void => {};
export const abytes = (_v: unknown, _l?: number, _t?: string): void => {};
export const ahash = (_h: unknown): void => {};
export const aexists = (_i: unknown, _c?: boolean): void => {};
export const aoutput = (_o: unknown, _i: unknown): void => {};
export const copyBytes = (b: Uint8Array): Uint8Array => new Uint8Array(b);
export const u8 = (arr: ArrayBufferView): Uint8Array =>
  new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
export const u32 = (data: ArrayBufferView): Uint32Array =>
  new Uint32Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 4));
export const clean = (..._arrays: ArrayBufferView[]): void => {};
export const createView = (arr: ArrayBufferView): DataView =>
  new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
export const rotr = (w: number, s: number): number => (w >>> s) | (w << (32 - s));
export const rotl = (w: number, s: number): number => (w << s) | (w >>> (32 - s));
export const isLE = true;
export const byteSwap = (w: number): number =>
  ((w & 0xff) << 24) | ((w & 0xff00) << 8) | ((w >>> 8) & 0xff00) | ((w >>> 24) & 0xff);
export const swap8IfBE = (n: number): number => n;
export const byteSwap32 = (arr: Uint32Array): Uint32Array => arr;
export const swap32IfBE = (u: Uint32Array): Uint32Array => u;

// Constructor wrappers + misc.
//
// Backed by Node's real SHA-256 (accumulating updates) instead of a
// zero-filled digest. The previous stub ignored every update() and
// returned new Uint8Array(32) (all zeros), so any consumer that hashed
// through wrapConstructor/Hash/HMAC silently produced a constant — a
// vacuous-crypto landmine identical to the old hmac stub. These now emit
// a real, input-dependent 32-byte digest.
const makeShaAccumulator = () => {
  const { createHash } = require('crypto') as typeof import('crypto');
  const h = createHash('sha256');
  const wrapper = {
    update(data: unknown) {
      if (data != null) {
        h.update(Buffer.from(data as Uint8Array));
      }
      return wrapper;
    },
    digest(): Uint8Array {
      return new Uint8Array(h.digest());
    },
  };
  return wrapper;
};
export const wrapConstructor = (_factory: unknown) => () => makeShaAccumulator();
export const wrapXOFConstructorWithOpts = wrapConstructor;
export const nextTick = async (): Promise<void> => Promise.resolve();
export const u64 = (n: bigint | number): Uint8Array => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return new Uint8Array(buf);
};
// Real SHA-256-backed streaming hash (was a zero-digest stub — same
// vacuous-crypto landmine as the old hmac/wrapConstructor stubs). Accumulates
// every update() and emits a real, input-dependent 32-byte digest so a test
// that relies on the output can no longer pass against a constant.
export const Hash = class {
  private readonly _h = (require('crypto') as typeof import('crypto')).createHash('sha256');
  update(data: unknown) {
    if (data != null) {
      this._h.update(Buffer.from(data as Uint8Array));
    }
    return this;
  }
  digest() { return new Uint8Array(this._h.digest()); }
  destroy() {}
  _cloneInto(_to?: unknown) { return new (this.constructor as new () => unknown)(); }
};
export const HMAC = Hash;
export const asyncLoop = async (
  iters: number,
  _tickMs: number,
  cb: (i: number) => void | Promise<void>,
): Promise<void> => {
  for (let i = 0; i < iters; i++) await cb(i);
};
