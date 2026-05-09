/**
 * Tests for the env-var-or-constant coordinator URL resolver.
 *
 * The CLI / desktop UI no longer let users configure the coord URL.
 * Resolution must always be: process.env.X || OFFICIAL_X. Anything else
 * (including legacy `config.coordinatorUrl` on disk) MUST be ignored.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  OFFICIAL_COORDINATOR_URL,
  OFFICIAL_COORDINATOR_WS_URL,
  getCoordinatorUrl,
  getCoordinatorWsUrl,
} from '../constants/coordinator';

describe('coordinator constants', () => {
  const originalHttp = process.env.COORDINATOR_URL;
  const originalWs = process.env.COORDINATOR_WS_URL;

  beforeEach(() => {
    delete process.env.COORDINATOR_URL;
    delete process.env.COORDINATOR_WS_URL;
  });

  afterEach(() => {
    if (originalHttp === undefined) delete process.env.COORDINATOR_URL;
    else process.env.COORDINATOR_URL = originalHttp;
    if (originalWs === undefined) delete process.env.COORDINATOR_WS_URL;
    else process.env.COORDINATOR_WS_URL = originalWs;
  });

  describe('getCoordinatorUrl', () => {
    it('returns the official constant when COORDINATOR_URL is unset', () => {
      expect(getCoordinatorUrl()).toBe(OFFICIAL_COORDINATOR_URL);
      expect(OFFICIAL_COORDINATOR_URL).toBe('https://api.synapseia.network');
    });

    it('returns COORDINATOR_URL when set', () => {
      process.env.COORDINATOR_URL = 'https://example.test:9001';
      expect(getCoordinatorUrl()).toBe('https://example.test:9001');
    });

    it('falls back to the constant when COORDINATOR_URL is empty', () => {
      process.env.COORDINATOR_URL = '';
      expect(getCoordinatorUrl()).toBe(OFFICIAL_COORDINATOR_URL);
    });

    it('falls back to the constant when COORDINATOR_URL is whitespace-only', () => {
      process.env.COORDINATOR_URL = '   ';
      expect(getCoordinatorUrl()).toBe(OFFICIAL_COORDINATOR_URL);
    });

    it('falls back to the constant when COORDINATOR_URL is tabs/newlines', () => {
      process.env.COORDINATOR_URL = '\t\n';
      expect(getCoordinatorUrl()).toBe(OFFICIAL_COORDINATOR_URL);
    });

    it('trims surrounding whitespace from COORDINATOR_URL', () => {
      process.env.COORDINATOR_URL = '  https://x.example.com  ';
      expect(getCoordinatorUrl()).toBe('https://x.example.com');
    });
  });

  describe('getCoordinatorWsUrl', () => {
    it('returns the official WS constant when COORDINATOR_WS_URL is unset', () => {
      expect(getCoordinatorWsUrl()).toBe(OFFICIAL_COORDINATOR_WS_URL);
      expect(OFFICIAL_COORDINATOR_WS_URL).toBe('https://ws.synapseia.network');
    });

    it('returns COORDINATOR_WS_URL when set', () => {
      process.env.COORDINATOR_WS_URL = 'wss://ws.example.test:9002';
      expect(getCoordinatorWsUrl()).toBe('wss://ws.example.test:9002');
    });

    it('falls back to the constant when COORDINATOR_WS_URL is empty', () => {
      process.env.COORDINATOR_WS_URL = '';
      expect(getCoordinatorWsUrl()).toBe(OFFICIAL_COORDINATOR_WS_URL);
    });

    it('falls back to the constant when COORDINATOR_WS_URL is whitespace-only', () => {
      process.env.COORDINATOR_WS_URL = '   ';
      expect(getCoordinatorWsUrl()).toBe(OFFICIAL_COORDINATOR_WS_URL);
    });

    it('falls back to the constant when COORDINATOR_WS_URL is tabs/newlines', () => {
      process.env.COORDINATOR_WS_URL = '\t\n';
      expect(getCoordinatorWsUrl()).toBe(OFFICIAL_COORDINATOR_WS_URL);
    });

    it('trims surrounding whitespace from COORDINATOR_WS_URL', () => {
      process.env.COORDINATOR_WS_URL = '  wss://x.example.com  ';
      expect(getCoordinatorWsUrl()).toBe('wss://x.example.com');
    });
  });
});
