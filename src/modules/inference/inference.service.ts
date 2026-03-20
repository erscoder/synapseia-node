import { Injectable } from '@nestjs/common';
import {
  startInferenceServer,
  parseBody,
  forwardToOllama,
  transformToOpenAI,
  handleChatCompletions,
  handleState,
  handleHealth,
  type InferenceServerConfig,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type OllamaChatResponse,
} from '../../inference-server.js';
import type * as http from 'http';

@Injectable()
export class InferenceService {
  start(config: InferenceServerConfig): { close: () => void; server: http.Server } {
    return startInferenceServer(config);
  }

  parseBody(req: http.IncomingMessage): Promise<unknown> {
    return parseBody(req);
  }

  forwardToOllama(request: ChatCompletionRequest): Promise<OllamaChatResponse> {
    return forwardToOllama(request);
  }

  transformToOpenAI(ollamaResponse: OllamaChatResponse, model: string): ChatCompletionResponse {
    return transformToOpenAI(ollamaResponse, model);
  }

  handleChatCompletions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    peerId: string,
  ): Promise<void> {
    return handleChatCompletions(req, res, peerId);
  }

  handleState(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    config: InferenceServerConfig,
  ): Promise<void> {
    return handleState(req, res, config);
  }

  handleHealth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    return handleHealth(req, res);
  }
}
