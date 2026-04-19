import { SynapseiaServingClient } from '../modules/llm/synapseia-serving-client';

describe('SynapseiaServingClient', () => {
  let originalFetch: typeof global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  it('throws when generate is called before setActiveVersion', async () => {
    const c = new SynapseiaServingClient();
    await expect(
      c.generate({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/not initialized/);
  });

  it('reports unavailable when health check fails', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const c = new SynapseiaServingClient();
    expect(await c.isAvailable()).toBe(false);
  });

  it('reports available when the runtime answers /v1/models', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const c = new SynapseiaServingClient();
    expect(await c.isAvailable()).toBe(true);
  });

  it('issues an OpenAI-compatible POST and returns content + modelVersion', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hello from synapseia' } }] }),
    });
    const c = new SynapseiaServingClient();
    c.setActiveVersion('synapseia-agent:gen-1:v2');
    const r = await c.generate({ messages: [{ role: 'user', content: 'Q?' }] });
    expect(r.content).toBe('hello from synapseia');
    expect(r.modelVersion).toBe('synapseia-agent:gen-1:v2');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/chat/completions'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws when the runtime returns a non-ok response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'model unavailable',
    });
    const c = new SynapseiaServingClient();
    c.setActiveVersion('synapseia-agent:gen-1:v2');
    await expect(
      c.generate({ messages: [{ role: 'user', content: 'Q?' }] }),
    ).rejects.toThrow(/HTTP 503/);
  });
});
