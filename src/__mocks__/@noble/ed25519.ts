// Mock for @noble/ed25519 — provides sync/async Ed25519 sign/verify
// Jest cannot parse noble's ESM, so we replace with a simple mock

const MOCK_PRIVATE_KEY = Buffer.alloc(32, 'secret');
const MOCK_PUBLIC_KEY = Buffer.alloc(32, 'publickey');

export const sign = jest.fn(async (_msg: Uint8Array, _privKey: Uint8Array) => {
  return new Uint8Array(64);
});

export const signAsync = jest.fn(async (_msg: Uint8Array, _privKey: Uint8Array) => {
  return new Uint8Array(64);
});

export const verify = jest.fn(async (_sig: Uint8Array, _msg: Uint8Array, _pubKey: Uint8Array) => {
  return true;
});

export const verifyAsync = jest.fn(async (_sig: Uint8Array, _msg: Uint8Array, _pubKey: Uint8Array) => {
  return true;
});

export const getPublicKey = jest.fn((_privKey: Uint8Array) => {
  return new Uint8Array(MOCK_PUBLIC_KEY);
});

export const getPublicKeyAsync = jest.fn(async (_privKey: Uint8Array) => {
  return new Uint8Array(MOCK_PUBLIC_KEY);
});

export const utils = {};
export const Point = {};
export const ExtendedPoint = {};

export const ed25519_CURVE = {};
export const etc = {};
