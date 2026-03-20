import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../inference-server.js', () => ({
  startInferenceServer: jest.fn(),
  parseBody: jest.fn(),
  forwardToOllama: jest.fn(),
  transformToOpenAI: jest.fn(),
  handleChatCompletions: jest.fn(),
  handleState: jest.fn(),
  handleHealth: jest.fn(),
}));

import * as inferenceHelper from '../../../inference-server.js';
import { InferenceService } from '../inference.service.js';

describe('InferenceService', () => {
  let service: InferenceService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new InferenceService();
  });

  it('start() delegates to startInferenceServer', () => {
    const mockServer = { close: jest.fn(), server: {} };
    const config = { port: 11435, ollamaUrl: 'http://localhost:11434', peerId: 'peer-1' };
    (inferenceHelper.startInferenceServer as jest.Mock<any>).mockReturnValue(mockServer);
    const result = service.start(config as any);
    expect(inferenceHelper.startInferenceServer).toHaveBeenCalledWith(config);
    expect(result).toBe(mockServer);
  });

  it('parseBody() delegates to parseBody', async () => {
    const mockReq = {} as any;
    const mockBody = { model: 'gpt-4', messages: [] };
    (inferenceHelper.parseBody as jest.Mock<any>).mockResolvedValue(mockBody);
    const result = await service.parseBody(mockReq);
    expect(inferenceHelper.parseBody).toHaveBeenCalledWith(mockReq);
    expect(result).toBe(mockBody);
  });

  it('forwardToOllama() delegates to forwardToOllama', async () => {
    const req = { model: 'llama2', messages: [{ role: 'user', content: 'hi' }] };
    const ollamaResp = { model: 'llama2', message: { content: 'hello' } };
    (inferenceHelper.forwardToOllama as jest.Mock<any>).mockResolvedValue(ollamaResp);
    const result = await service.forwardToOllama(req as any);
    expect(inferenceHelper.forwardToOllama).toHaveBeenCalledWith(req);
    expect(result).toBe(ollamaResp);
  });

  it('transformToOpenAI() delegates to transformToOpenAI', () => {
    const ollamaResp = { model: 'llama2', message: { content: 'hi' } };
    const openAIResp = { choices: [{ message: { content: 'hi' } }] };
    (inferenceHelper.transformToOpenAI as jest.Mock<any>).mockReturnValue(openAIResp);
    const result = service.transformToOpenAI(ollamaResp as any, 'llama2');
    expect(inferenceHelper.transformToOpenAI).toHaveBeenCalledWith(ollamaResp, 'llama2');
    expect(result).toBe(openAIResp);
  });

  it('handleChatCompletions() delegates to handleChatCompletions', async () => {
    const req = {} as any;
    const res = {} as any;
    (inferenceHelper.handleChatCompletions as jest.Mock<any>).mockResolvedValue(undefined);
    await service.handleChatCompletions(req, res, 'peer-1');
    expect(inferenceHelper.handleChatCompletions).toHaveBeenCalledWith(req, res, 'peer-1');
  });

  it('handleState() delegates to handleState', async () => {
    const req = {} as any;
    const res = {} as any;
    const config = { port: 11435, peerId: 'peer-1' };
    (inferenceHelper.handleState as jest.Mock<any>).mockResolvedValue(undefined);
    await service.handleState(req, res, config as any);
    expect(inferenceHelper.handleState).toHaveBeenCalledWith(req, res, config);
  });

  it('handleHealth() delegates to handleHealth', async () => {
    const req = {} as any;
    const res = {} as any;
    (inferenceHelper.handleHealth as jest.Mock<any>).mockResolvedValue(undefined);
    await service.handleHealth(req, res);
    expect(inferenceHelper.handleHealth).toHaveBeenCalledWith(req, res);
  });
});
