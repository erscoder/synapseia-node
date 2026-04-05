// Mock for @noble/hashes — provides SHA256 and other hash functions
// Jest cannot parse noble's ESM, so we replace with Node's crypto

import { createHash } from 'crypto';

export const sha256 = {
  digest: (data: Uint8Array | string): Uint8Array => {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    return new Uint8Array(createHash('sha256').update(text).digest());
  },
};

export const sha512 = {
  digest: (data: Uint8Array | string): Uint8Array => {
    const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    return new Uint8Array(createHash('sha512').update(text).digest());
  },
};

export const hmac = {
  create: () => ({
    update: (data: Uint8Array) => hmac,
    digest: () => new Uint8Array(32),
  }),
};

export const randomBytes = (bytes: number): Uint8Array => {
  const { randomBytes: rb } = require('crypto') as typeof import('crypto');
  return new Uint8Array(rb(bytes));
};
