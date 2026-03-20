import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { InferenceService } from '../inference.service.js';
import { InferenceServerHelper } from '../../inference-server.js';

describe('InferenceService', () => {
  let service: InferenceService;
  let inferenceServerHelper: jest.Mocked<InferenceServerHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        InferenceService,
        {
          provide: InferenceServerHelper,
          useValue: {
            startInferenceServer: jest.fn(),
            parseBody: jest.fn(),
            forwardToOllama: jest.fn(),
            transformToOpenAI: jest.fn(),
            handleChatCompletions: jest.fn(),
            handleState: jest.fn(),
            handleHealth: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<InferenceService>(InferenceService);
    inferenceServerHelper = module.get(InferenceServerHelper);
  });

  it('start() delegates to startInferenceServer', () => {
    const mockServer = { close: jest.fn(), server: {} };
    const config = { port: 11435, ollamaUrl: 'http://localhost:11434', peerId: 'peer-1' };
    inferenceServerHelper.startInferenceServer.mockReturnValue(mockServer as any);
    const result = service.start(config as any);
    expect(inferenceServerHelper.startInferenceServer).toHaveBeenCalledWith(config);
    expect(result).toBe(mockServer);
  });

  it('parseBody() delegates to parseBody', async () => {
    const mockReq = {} as any;
    const mockBody = { model: 'gpt-4', messages: [] };
    inferenceServerHelper.parseBody.mockResolvedValue(mockBody);
    const result = await service.parseBody(mockReq);
    expect(inferenceServerHelper.parseBody).toHaveBeenCalledWith(mockReq);
    expect(result).toBe(mockBody);
  });

  it('forwardToOllama() delegates to forwardToOllama', async () => {
    const req = { model: 'llama2', messages: [{ role: 'user', content: 'hi' }] };
    const ollamaResp = { model: 'llama2', message: { content: 'hello' } };
    inferenceServerHelper.forwardToOllama.mockResolvedValue(ollamaResp as any);
    const result = await service.forwardToOllama(req as any);
    expect(inferenceServerHelper.forwardToOllama).toHaveBeenCalledWith(req);
    expect(result).toBe(ollamaResp);
  });

  it('transformToOpenAI() delegates to transformToOpenAI', () => {
    const ollamaResp = { model: 'llama2', message: { content: 'hi' } };
    const openAIResp = { choices: [{ message: { content: 'hi' } }] };
    inferenceServerHelper.transformToOpenAI.mockReturnValue(openAIResp as any);
    const result = service.transformToOpenAI(ollamaResp as any, 'llama2');
    expect(inferenceServerHelper.transformToOpenAI).toHaveBeenCalledWith(ollamaResp, 'llama2');
    expect(result).toBe(openAIResp);
  });

  it('handleChatCompletions() delegates to handleChatCompletions', async () => {
    const req = {} as any;
    const res = {} as any;
    inferenceServerHelper.handleChatCompletions.mockResolvedValue(undefined);
    await service.handleChatCompletions(req, res, 'peer-1');
    expect(inferenceServerHelper.handleChatCompletions).toHaveBeenCalledWith(req, res, 'peer-1');
  });

  it('handleState() delegates to handleState', async () => {
    const req = {} as any;
    const res = {} as any;
    const config = { port: 11435, peerId: 'peer-1' };
    inferenceServerHelper.handleState.mockResolvedValue(undefined);
    await service.handleState(req, res, config as any);
    expect(inferenceServerHelper.handleState).toHaveBeenCalledWith(req, res, config);
  });

  it('handleHealth() delegates to handleHealth', async () => {
    const req = {} as any;
    const res = {} as any;
    inferenceServerHelper.handleHealth.mockResolvedValue(undefined);
    await service.handleHealth(req, res);
    expect(inferenceServerHelper.handleHealth).toHaveBeenCalledWith(req, res);
  });
});
