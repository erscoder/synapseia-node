import { Injectable } from '@nestjs/common';
import {
  type InferenceServerConfig,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type OllamaChatResponse,
} from '../inference-server';
import { InferenceServerHelper } from '../inference-server';
import type * as http from 'http';

@Injectable()
export class InferenceService {
  constructor(
    private readonly inferenceServerHelper: InferenceServerHelper,
  ) {}

  start(config: InferenceServerConfig): { close: () => void; server: http.Server } {
    return this.inferenceServerHelper.startInferenceServer(config);
  }

  parseBody(req: http.IncomingMessage): Promise<unknown> {
    return this.inferenceServerHelper.parseBody(req);
  }

  forwardToOllama(request: ChatCompletionRequest): Promise<OllamaChatResponse> {
    return this.inferenceServerHelper.forwardToOllama(request);
  }

  transformToOpenAI(ollamaResponse: OllamaChatResponse, model: string): ChatCompletionResponse {
    return this.inferenceServerHelper.transformToOpenAI(ollamaResponse, model);
  }

  handleChatCompletions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    peerId: string,
    coordinatorUrl?: string,
  ): Promise<void> {
    return this.inferenceServerHelper.handleChatCompletions(req, res, peerId, coordinatorUrl);
  }

  handleState(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    config: InferenceServerConfig,
  ): Promise<void> {
    return this.inferenceServerHelper.handleState(req, res, config);
  }

  handleHealth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return this.inferenceServerHelper.handleHealth(req, res);
  }
}
