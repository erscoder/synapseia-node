/**
 * Bug 40 (0.8.91) — Regression spec
 *
 * Four production-code sites used to default the coordinator URL with an
 * inline `?? 'http://localhost:3701'` fallback when COORDINATOR_URL was
 * not set. That fallback only resolves for in-cluster coordinator
 * developers and is a latent foot-gun on fresh installs. Reviewer lesson
 * P6 (grep ALL paths before declaring a guard "done") and P10 (truthful
 * comments) drove the migration to the central `getCoordinatorUrl()`
 * helper.
 *
 * This spec exercises each of the four sites with COORDINATOR_URL
 * deleted and asserts they hit the official coordinator host
 * (`https://api.synapseia.network`), not the dev-only localhost:3701.
 */

import { OFFICIAL_COORDINATOR_URL } from '../constants/coordinator';
import { SolanaBalanceHelper } from '../modules/wallet/solana-balance';
import { KnowledgeQueryHandler } from '../modules/a2a/handlers/knowledge-query.handler';

describe('Bug 40 — 4 sites must route through getCoordinatorUrl() helper, no inline localhost:3701', () => {
  const OLD_ENV = process.env.COORDINATOR_URL;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    delete process.env.COORDINATOR_URL;
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (OLD_ENV !== undefined) process.env.COORDINATOR_URL = OLD_ENV;
    else delete process.env.COORDINATOR_URL;
  });

  it('OFFICIAL_COORDINATOR_URL constant pins to https://api.synapseia.network (sanity)', () => {
    expect(OFFICIAL_COORDINATOR_URL).toBe('https://api.synapseia.network');
  });

  describe('Site 1 — active-model-subscriber.tick()', () => {
    it('targets OFFICIAL_COORDINATOR_URL/models/active when env is unset', async () => {
      // Import lazily so the module re-reads process.env on construction.
      const { ActiveModelSubscriber } = await import(
        '../modules/model/active-model-subscriber'
      );
      // Stub serving — tick() only needs an object whose methods are not
      // called on the early-return failure path. We force a 500 so the
      // tick bails right after fetch.
      fetchSpy.mockResolvedValueOnce(
        new Response('', { status: 500 }),
      );
      const stubServing: any = {
        setActiveModel: jest.fn(),
        getActiveModel: jest.fn().mockReturnValue(null),
      };
      await new ActiveModelSubscriber(stubServing).tick();
      expect(fetchSpy).toHaveBeenCalled();
      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl).toBe(`${OFFICIAL_COORDINATOR_URL}/models/active`);
      expect(calledUrl).not.toContain('localhost:3701');
    });
  });

  describe('Site 2 — knowledge-query.handler', () => {
    it('passes OFFICIAL_COORDINATOR_URL to the coordinator helper when env is unset', async () => {
      const fetchKGraphContext = jest.fn().mockResolvedValue('ctx');
      const handler = new KnowledgeQueryHandler({
        fetchKGraphContext,
      } as any);
      await handler.handle({ topic: 'protein folding' });
      expect(fetchKGraphContext).toHaveBeenCalledTimes(1);
      const passedUrl = fetchKGraphContext.mock.calls[0][0];
      expect(passedUrl).toBe(OFFICIAL_COORDINATOR_URL);
      expect(passedUrl).not.toContain('localhost:3701');
    });
  });

  describe('Site 3 — solana-balance.getStakedAmount default param', () => {
    it('falls back to OFFICIAL_COORDINATOR_URL when caller omits coordinatorUrl arg', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ totalStaked: '42' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const helper = new SolanaBalanceHelper();
      await helper.getStakedAmount('wallet-abc');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl.startsWith(`${OFFICIAL_COORDINATOR_URL}/stake/staker/`)).toBe(true);
      expect(calledUrl).not.toContain('localhost:3701');
    });

    it('still honors explicit coordinatorUrl argument (back-compat)', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ totalStaked: '7' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const helper = new SolanaBalanceHelper();
      await helper.getStakedAmount('wallet-abc', 'http://custom-coord:9999');
      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl.startsWith('http://custom-coord:9999/stake/staker/')).toBe(true);
    });
  });

  describe('Site 4 — solana-balance.stakeTokens default param', () => {
    it('falls back to OFFICIAL_COORDINATOR_URL when caller omits coordinatorUrl arg', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ txSignature: 'sig', stakeAddress: 'stk' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const helper = new SolanaBalanceHelper();
      await helper.stakeTokens('wallet-abc', '100');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl).toBe(`${OFFICIAL_COORDINATOR_URL}/stake`);
      expect(calledUrl).not.toContain('localhost:3701');
    });

    it('still honors explicit coordinatorUrl argument (back-compat)', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ txSignature: 'sig', stakeAddress: 'stk' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const helper = new SolanaBalanceHelper();
      await helper.stakeTokens('wallet-abc', '100', 'http://custom-coord:9999');
      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl).toBe('http://custom-coord:9999/stake');
    });
  });

  describe('Env override wins over default (regression guard)', () => {
    it('active-model-subscriber respects COORDINATOR_URL env when set', async () => {
      process.env.COORDINATOR_URL = 'http://override.local:4242';
      const { ActiveModelSubscriber } = await import(
        '../modules/model/active-model-subscriber'
      );
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));
      const stubServing: any = {
        setActiveModel: jest.fn(),
        getActiveModel: jest.fn().mockReturnValue(null),
      };
      await new ActiveModelSubscriber(stubServing).tick();
      const calledUrl = String(fetchSpy.mock.calls[0][0]);
      expect(calledUrl).toBe('http://override.local:4242/models/active');
    });

    it('knowledge-query handler respects COORDINATOR_URL env when set', async () => {
      process.env.COORDINATOR_URL = 'http://override.local:4242';
      const fetchKGraphContext = jest.fn().mockResolvedValue('ctx');
      const handler = new KnowledgeQueryHandler({
        fetchKGraphContext,
      } as any);
      await handler.handle({ topic: 'topic' });
      expect(fetchKGraphContext.mock.calls[0][0]).toBe('http://override.local:4242');
    });
  });
});
