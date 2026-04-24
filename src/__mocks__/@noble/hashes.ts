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
