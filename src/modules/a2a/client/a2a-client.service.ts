/**
 * A2A Client Service
 * Sprint E — A2A Client for Synapseia Node
 *
 * Sends tasks to remote A2A agents (other nodes).
 * Always returns an A2ATaskResult — never throws.
 * Integrates with CircuitBreakerService for fault tolerance.
 */

import { Injectable } from '@nestjs/common';
import { A2AAuthService } from '../auth/a2a-auth.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import type { A2ATask, A2ATaskResult, A2ATaskType } from '../types';

@Injectable()
export class A2AClientService {
  private readonly TIMEOUT_MS = 30_000;

  constructor(
    private readonly authService: A2AAuthService,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  /**
   * Send a task to a remote A2A agent.
   *
   * @param targetUrl      Base URL of the target node (e.g. "http://192.168.1.5:8080")
   * @param taskType       Type of A2A task
   * @param payload        Task payload
   * @param ourPeerId      Our own peerId (included in task)
   * @param ourPrivateKeyHex  Our private key for signing
   */
  async sendTask(
    targetUrl: string,
    taskType: A2ATaskType,
    payload: Record<string, unknown>,
    ourPeerId: string,
    ourPrivateKeyHex: string,
  ): Promise<A2ATaskResult> {
    const start = Date.now();

    // Check circuit breaker
    if (this.circuitBreaker.isOpen(targetUrl)) {
      return {
        taskId: 'circuit-open',
        success: false,
        data: null,
        error: `Circuit open for ${targetUrl}`,
        processingMs: 0,
      };
    }

    try {
      const task: Omit<A2ATask, 'signature'> = {
        id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: taskType,
        payload,
        senderPeerId: ourPeerId,
        timestamp: Date.now(),
        nonce: Math.random().toString(36).slice(2, 18),
      };

      const signature = this.authService.sign(task, ourPrivateKeyHex);
      const signedTask: A2ATask = { ...task, signature };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${targetUrl}/tasks/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task: signedTask }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        const text = await res.text();
        this.circuitBreaker.recordFailure(targetUrl);
        return {
          taskId: task.id,
          success: false,
          data: null,
          error: text,
          processingMs: Date.now() - start,
        };
      }

      const result = await res.json() as A2ATaskResult;
      this.circuitBreaker.recordSuccess(targetUrl);
      return { ...result, processingMs: Date.now() - start };

    } catch (error) {
      this.circuitBreaker.recordFailure(targetUrl);
      return {
        taskId: 'error',
        success: false,
        data: null,
        error: (error as Error).message,
        processingMs: Date.now() - start,
      };
    }
  }

  /**
   * Send a task to a specific peer URL (bypassing peer selector).
   * Useful when the coordinator assigns a specific peer.
   */
  async sendTaskToUrl(
    targetUrl: string,
    taskType: A2ATaskType,
    payload: Record<string, unknown>,
    ourPeerId: string,
    ourPrivateKeyHex: string,
  ): Promise<A2ATaskResult> {
    return this.sendTask(targetUrl, taskType, payload, ourPeerId, ourPrivateKeyHex);
  }
}
