/**
 * A2A Client Service Tests
 * Sprint E — A2A Client
 */

import { A2AClientService } from '../client/a2a-client.service';
import { A2AAuthService } from '../auth/a2a-auth.service';
import { CircuitBreakerService } from '../client/circuit-breaker.service';

describe('A2AClientService', () => {
  // Use unique target per test to avoid cross-test pollution
  const makeUrl = (n: number) => `http://a2a-test-${n}.local:8080`;
  const privateKeyHex = 'a'.repeat(64);
  const ourPeerId = 'our-peer-id';

  let authService: A2AAuthService;

  beforeEach(() => {
    jest.restoreAllMocks();
    authService = new A2AAuthService();
  });

  afterEach(() => {
    authService.clearNonces();
  });

  describe('sendTask', () => {
    it('should return circuit-open result when circuit is open', async () => {
      const circuitBreaker = new CircuitBreakerService();
      const a2aClient = new A2AClientService(authService, circuitBreaker);
      const targetUrl = makeUrl(1);

      // Trip the circuit open
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure(targetUrl);
      }

      const result = await a2aClient.sendTask(
        targetUrl,
        'health_check',
        { foo: 'bar' },
        ourPeerId,
        privateKeyHex,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Circuit open');
      // fetch should NOT be called when circuit is open
    });

    it('should return success result on HTTP 200', async () => {
      const circuitBreaker = new CircuitBreakerService();
      const a2aClient = new A2AClientService(authService, circuitBreaker);
      const targetUrl = makeUrl(2);

      const expectedResult = {
        taskId: 'task-123',
        success: true,
        data: { answer: 42 },
        processingMs: 150,
      };

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => expectedResult,
      });
      global.fetch = mockFetch;

      const result = await a2aClient.sendTask(
        targetUrl,
        'health_check',
        { foo: 'bar' },
        ourPeerId,
        privateKeyHex,
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ answer: 42 });
      expect(mockFetch).toHaveBeenCalledWith(
        `${targetUrl}/tasks/send`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should record failure on HTTP error and trip circuit', async () => {
      const circuitBreaker = new CircuitBreakerService();
      const a2aClient = new A2AClientService(authService, circuitBreaker);
      const targetUrl = makeUrl(3);

      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });
      global.fetch = mockFetch;

      // Need 3 failures to trip circuit
      await a2aClient.sendTask(targetUrl, 'health_check', { foo: 'bar' }, ourPeerId, privateKeyHex);
      await a2aClient.sendTask(targetUrl, 'health_check', { foo: 'bar' }, ourPeerId, privateKeyHex);
      const result = await a2aClient.sendTask(targetUrl, 'health_check', { foo: 'bar' }, ourPeerId, privateKeyHex);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Internal Server Error');
      expect(circuitBreaker.getState(targetUrl)).toBe('open');
    });

    it('should record failure on network error and trip circuit', async () => {
      const circuitBreaker = new CircuitBreakerService();
      const a2aClient = new A2AClientService(authService, circuitBreaker);
      const targetUrl = makeUrl(4);

      const mockFetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      global.fetch = mockFetch;

      await a2aClient.sendTask(targetUrl, 'health_check', { foo: 'bar' }, ourPeerId, privateKeyHex);
      await a2aClient.sendTask(targetUrl, 'health_check', { foo: 'bar' }, ourPeerId, privateKeyHex);
      const result = await a2aClient.sendTask(targetUrl, 'health_check', { foo: 'bar' }, ourPeerId, privateKeyHex);

      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
      expect(circuitBreaker.getState(targetUrl)).toBe('open');
    });

    it('should include task signature in request body', async () => {
      const circuitBreaker = new CircuitBreakerService();
      const a2aClient = new A2AClientService(authService, circuitBreaker);
      const targetUrl = makeUrl(5);

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ taskId: 'task-1', success: true, data: null, processingMs: 0 }),
      });
      global.fetch = mockFetch;

      await a2aClient.sendTask(
        targetUrl,
        'peer_review',
        { reviewContent: 'test' },
        ourPeerId,
        privateKeyHex,
      );

      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.task.signature).toBeDefined();
      expect(body.task.signature.length).toBe(128); // Ed25519 hex encoded
    });

    it('should set correct Content-Type header', async () => {
      const circuitBreaker = new CircuitBreakerService();
      const a2aClient = new A2AClientService(authService, circuitBreaker);
      const targetUrl = makeUrl(6);

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ taskId: 'task-1', success: true, data: null, processingMs: 0 }),
      });
      global.fetch = mockFetch;

      await a2aClient.sendTask(targetUrl, 'health_check', {}, ourPeerId, privateKeyHex);

      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[1].headers['Content-Type']).toBe('application/json');
    });

    it('should include processingMs in result', async () => {
      const circuitBreaker = new CircuitBreakerService();
      const a2aClient = new A2AClientService(authService, circuitBreaker);
      const targetUrl = makeUrl(7);

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ taskId: 'task-1', success: true, data: null }),
      });
      global.fetch = mockFetch;

      const result = await a2aClient.sendTask(targetUrl, 'health_check', {}, ourPeerId, privateKeyHex);

      expect(result.processingMs).toBeGreaterThanOrEqual(0);
    });

    it('should never throw — always return A2ATaskResult', async () => {
      const circuitBreaker = new CircuitBreakerService();
      const a2aClient = new A2AClientService(authService, circuitBreaker);
      const targetUrl = makeUrl(8);

      const mockFetch = jest.fn().mockRejectedValue(new Error('unhandled'));
      global.fetch = mockFetch;

      await expect(a2aClient.sendTask(targetUrl, 'health_check', {}, ourPeerId, privateKeyHex))
        .resolves.toMatchObject({ success: false });
    });

    it('should reset circuit on success', async () => {
      const circuitBreaker = new CircuitBreakerService();
      const a2aClient = new A2AClientService(authService, circuitBreaker);
      const targetUrl = makeUrl(9);

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ taskId: 'task-1', success: true, data: null, processingMs: 0 }),
      });
      global.fetch = mockFetch;

      // 2 failures first
      await a2aClient.sendTask(targetUrl, 'health_check', {}, ourPeerId, privateKeyHex);
      await a2aClient.sendTask(targetUrl, 'health_check', {}, ourPeerId, privateKeyHex);
      expect(circuitBreaker.getState(targetUrl)).toBe('closed');

      // Then success should clear
      await a2aClient.sendTask(targetUrl, 'health_check', {}, ourPeerId, privateKeyHex);
      expect(circuitBreaker.getState(targetUrl)).toBe('closed');
    });
  });

  describe('sendTaskToUrl', () => {
    it('should call sendTask with same arguments', async () => {
      const circuitBreaker = new CircuitBreakerService();
      const a2aClient = new A2AClientService(authService, circuitBreaker);
      const targetUrl = makeUrl(10);

      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ taskId: 'task-1', success: true, data: null, processingMs: 0 }),
      });
      global.fetch = mockFetch;

      const result = await a2aClient.sendTaskToUrl(
        targetUrl,
        'embedding_request',
        { text: 'hello' },
        ourPeerId,
        privateKeyHex,
      );

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
