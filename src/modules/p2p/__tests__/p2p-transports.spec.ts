/**
 * Verifies the libp2p node is created with BOTH the tcp and webSockets
 * transports. The webSockets transport is the fix that lets the node reach
 * the public coordinator over Fly's TLS-terminated secure-WebSocket edge
 * (raw TCP 9000 is RESET on the Fly shared IP). `tcp()` stays as a local /
 * dev fallback.
 *
 * `libp2p` and every `@libp2p/*` import resolve to the jest mocks under
 * `src/__mocks__` (see jest.config.mjs moduleNameMapper). The tcp mock
 * returns the sentinel `'tcp-transport'` and the websockets mock returns
 * `'websockets-transport'`, so we can assert the exact transport list
 * passed to `createLibp2p`.
 */
import { jest } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Point the libp2p key dir at a throwaway tmp path BEFORE importing p2p.ts
// (SYNAPSEIA_HOME is read into a module-level const at import time). The
// key file does not exist → the node generates a fresh key (crypto mock).
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-p2p-test-'));
process.env.SYNAPSEIA_HOME = TMP_HOME;

import { createLibp2p } from 'libp2p';
import { P2PNode } from '../p2p';

const createLibp2pMock = createLibp2p as unknown as jest.Mock;

function makeNodeStub() {
  return {
    start: jest.fn(async () => undefined),
    services: { pubsub: { addEventListener: jest.fn(), subscribe: jest.fn() } },
    peerId: { toString: () => '12D3KooWStub' },
    getMultiaddrs: () => [],
    addEventListener: jest.fn(),
  };
}

describe('P2PNode transport configuration', () => {
  beforeEach(() => {
    createLibp2pMock.mockReset();
    createLibp2pMock.mockResolvedValue(makeNodeStub() as never);
  });

  afterAll(() => {
    fs.rmSync(TMP_HOME, { recursive: true, force: true });
  });

  it('creates the node with both tcp() and webSockets() transports', async () => {
    const identity = { peerId: 'node-peer', publicKeyHex: 'ab'.repeat(32) } as never;
    const node = new P2PNode(identity);

    await node.start([]);

    expect(createLibp2pMock).toHaveBeenCalledTimes(1);
    const cfg = createLibp2pMock.mock.calls[0][0] as { transports: unknown[] };
    expect(cfg.transports).toContain('tcp-transport');
    expect(cfg.transports).toContain('websockets-transport');
    expect(cfg.transports).toHaveLength(2);
  });
});
