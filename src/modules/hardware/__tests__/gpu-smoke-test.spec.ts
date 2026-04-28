import { runGpuSmokeTest } from '../gpu-smoke-test';
import type { Hardware } from '../hardware';

function hw(over: Partial<Hardware> = {}): Hardware {
  return {
    cpuCores: 8,
    ramGb: 16,
    gpuVramGb: 8,
    gpuModel: 'NVIDIA RTX 4090',
    tier: 3,
    hasOllama: true,
    ...over,
  };
}

describe('runGpuSmokeTest', () => {
  it('returns skipped when no GPU is detected', async () => {
    const out = await runGpuSmokeTest({
      hardware: hw({ gpuVramGb: 0, gpuModel: undefined }),
      ollamaUrl: 'http://localhost:11434',
    });
    expect(out.status).toBe('skipped');
    expect(out.probe).toBe('cpu');
  });

  it('returns skipped when GPU exists but Ollama is unavailable', async () => {
    const out = await runGpuSmokeTest({
      hardware: hw({ hasOllama: false }),
      ollamaUrl: 'http://localhost:11434',
    });
    expect(out.status).toBe('skipped');
    expect(out.errorMessage).toContain('Ollama');
  });

  it('infers ollama-cuda probe for NVIDIA hardware', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'hi' }),
    });
    const out = await runGpuSmokeTest({
      hardware: hw({ gpuModel: 'NVIDIA RTX 4090' }),
      ollamaUrl: 'http://localhost:11434',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out.probe).toBe('ollama-cuda');
    expect(out.status).toBe('passed');
  });

  it('infers ollama-metal probe for Apple Silicon', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'hi' }),
    });
    const out = await runGpuSmokeTest({
      hardware: hw({ gpuModel: 'Apple M1 Pro' }),
      ollamaUrl: 'http://localhost:11434',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out.probe).toBe('ollama-metal');
  });

  it('returns passed with latencyMs on a successful smoke', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: 'hello back' }),
    });
    const out = await runGpuSmokeTest({
      hardware: hw(),
      ollamaUrl: 'http://localhost:11434',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out.status).toBe('passed');
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.options.num_gpu).toBe(99);
  });

  it('returns failed with HTTP status on non-2xx', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'oops',
    });
    const out = await runGpuSmokeTest({
      hardware: hw(),
      ollamaUrl: 'http://localhost:11434',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out.status).toBe('failed');
    expect(out.errorMessage).toContain('500');
    expect(out.fallbackToCpu).toBe(true);
  });

  it('returns failed when response body is empty', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    const out = await runGpuSmokeTest({
      hardware: hw(),
      ollamaUrl: 'http://localhost:11434',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(out.status).toBe('failed');
    expect(out.errorMessage).toContain('empty');
  });

  it('returns failed with timeout message when AbortError fires', async () => {
    // Simulate AbortController firing
    const fetchMock = jest.fn().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const out = await runGpuSmokeTest({
      hardware: hw(),
      ollamaUrl: 'http://localhost:11434',
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 50,
    });
    expect(out.status).toBe('failed');
    expect(out.errorMessage).toContain('timeout');
  });
});
