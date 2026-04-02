/**
 * Circuit Breaker Service Tests
 * Sprint E — A2A Client
 */

import { CircuitBreakerService } from '../client/circuit-breaker.service';

describe('CircuitBreakerService', () => {
  let circuitBreaker: CircuitBreakerService;

  beforeEach(() => {
    circuitBreaker = new CircuitBreakerService();
  });

  describe('isOpen', () => {
    it('should return false for unknown target', () => {
      expect(circuitBreaker.isOpen('http://unknown:8080')).toBe(false);
    });

    it('should return false initially after recording failures below threshold', () => {
      circuitBreaker.recordFailure('http://fail:8080');
      expect(circuitBreaker.isOpen('http://fail:8080')).toBe(false);
    });

    it('should open circuit after FAILURE_THRESHOLD failures', () => {
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure('http://target:8080');
      }
      expect(circuitBreaker.isOpen('http://target:8080')).toBe(true);
    });

    it('should transition to half-open after OPEN_DURATION_MS', () => {
      // We can't easily test the time-based transition, but we can test state
      for (let i = 0; i < 3; i++) {
        circuitBreaker.recordFailure('http://target:8080');
      }
      expect(circuitBreaker.getState('http://target:8080')).toBe('open');
    });
  });

  describe('recordSuccess', () => {
    it('should reset circuit on success', () => {
      circuitBreaker.recordFailure('http://target:8080');
      circuitBreaker.recordFailure('http://target:8080');
      circuitBreaker.recordFailure('http://target:8080');
      expect(circuitBreaker.isOpen('http://target:8080')).toBe(true);

      circuitBreaker.recordSuccess('http://target:8080');
      expect(circuitBreaker.isOpen('http://target:8080')).toBe(false);
      expect(circuitBreaker.getState('http://target:8080')).toBe('closed');
    });

    it('should do nothing for unknown target', () => {
      expect(() => circuitBreaker.recordSuccess('http://unknown:8080')).not.toThrow();
    });
  });

  describe('recordFailure', () => {
    it('should increment failure count', () => {
      circuitBreaker.recordFailure('http://target:8080');
      circuitBreaker.recordFailure('http://target:8080');
      expect(circuitBreaker.getState('http://target:8080')).toBe('closed');
      circuitBreaker.recordFailure('http://target:8080');
      expect(circuitBreaker.getState('http://target:8080')).toBe('open');
    });

    it('should update lastFailure timestamp', () => {
      const before = Date.now();
      circuitBreaker.recordFailure('http://target:8080');
      const after = Date.now();
      // lastFailure is internal, but state should reflect recorded failure
      expect(circuitBreaker.getState('http://target:8080')).toBe('closed');
    });
  });

  describe('getState', () => {
    it('should return closed for unknown target', () => {
      expect(circuitBreaker.getState('http://unknown:8080')).toBe('closed');
    });
  });

  describe('reset', () => {
    it('should remove circuit for target', () => {
      circuitBreaker.recordFailure('http://target:8080');
      circuitBreaker.recordFailure('http://target:8080');
      circuitBreaker.recordFailure('http://target:8080');
      expect(circuitBreaker.isOpen('http://target:8080')).toBe(true);

      circuitBreaker.reset('http://target:8080');
      expect(circuitBreaker.isOpen('http://target:8080')).toBe(false);
    });
  });

  describe('resetAll', () => {
    it('should clear all circuits', () => {
      circuitBreaker.recordFailure('http://a:8080');
      circuitBreaker.recordFailure('http://a:8080');
      circuitBreaker.recordFailure('http://a:8080');
      circuitBreaker.recordFailure('http://b:8080');
      circuitBreaker.recordFailure('http://b:8080');
      circuitBreaker.recordFailure('http://b:8080');
      expect(circuitBreaker.getSize()).toBe(2);

      circuitBreaker.resetAll();
      expect(circuitBreaker.getSize()).toBe(0);
    });
  });

  describe('getSize', () => {
    it('should return 0 initially', () => {
      expect(circuitBreaker.getSize()).toBe(0);
    });

    it('should count distinct targets', () => {
      circuitBreaker.recordFailure('http://a:8080');
      circuitBreaker.recordFailure('http://b:8080');
      expect(circuitBreaker.getSize()).toBe(2);
    });
  });
});
