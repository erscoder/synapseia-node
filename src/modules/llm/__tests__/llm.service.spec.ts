import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../llm-provider.js', () => ({
  checkLLM: jest.fn(),
  generateLLM: jest.fn(),
  parseModel: jest.fn(),
  SUPPORTED_MODELS: ['ollama/qwen2.5:0.5b', 'ollama/llama2'],
  MODEL_METADATA: { 'qwen2.5:0.5b': { vramRequired: 1 } },
}));

jest.mock('../../../ollama.js', () => ({
  checkOllama: jest.fn(),
  generate: jest.fn(),
}));

import * as llmHelper from '../../../llm-provider.js';
import * as ollamaHelper from '../../../ollama.js';
import { LlmService } from '../llm.service.js';

const mockModel = { provider: 'ollama', modelId: 'qwen2.5:0.5b' };

describe('LlmService', () => {
  let service: LlmService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LlmService();
  });

  it('parse() delegates to parseModel', () => {
    (llmHelper.parseModel as jest.Mock<any>).mockReturnValue(mockModel);
    const result = service.parse('ollama/qwen2.5:0.5b');
    expect(llmHelper.parseModel).toHaveBeenCalledWith('ollama/qwen2.5:0.5b');
    expect(result).toBe(mockModel);
  });

  it('parse() returns null for invalid model', () => {
    (llmHelper.parseModel as jest.Mock<any>).mockReturnValue(null);
    const result = service.parse('invalid');
    expect(result).toBeNull();
  });

  it('check() delegates to checkLLM', async () => {
    const status = { available: true };
    (llmHelper.checkLLM as jest.Mock<any>).mockResolvedValue(status);
    const result = await service.check(mockModel as any);
    expect(llmHelper.checkLLM).toHaveBeenCalledWith(mockModel, undefined);
    expect(result).toBe(status);
  });

  it('check() passes config', async () => {
    (llmHelper.checkLLM as jest.Mock<any>).mockResolvedValue({ available: false });
    const config = { llmUrl: 'http://custom.api' };
    await service.check(mockModel as any, config as any);
    expect(llmHelper.checkLLM).toHaveBeenCalledWith(mockModel, config);
  });

  it('generate() delegates to generateLLM', async () => {
    (llmHelper.generateLLM as jest.Mock<any>).mockResolvedValue('result text');
    const result = await service.generate(mockModel as any, 'hello');
    expect(llmHelper.generateLLM).toHaveBeenCalledWith(mockModel, 'hello', undefined);
    expect(result).toBe('result text');
  });

  it('generate() passes config', async () => {
    (llmHelper.generateLLM as jest.Mock<any>).mockResolvedValue('text');
    const config = { llmUrl: 'http://api' };
    await service.generate(mockModel as any, 'prompt', config as any);
    expect(llmHelper.generateLLM).toHaveBeenCalledWith(mockModel, 'prompt', config);
  });

  it('checkOllama() delegates to ollama checkOllama', async () => {
    (ollamaHelper.checkOllama as jest.Mock<any>).mockResolvedValue({ running: true });
    const result = await service.checkOllama();
    expect(ollamaHelper.checkOllama).toHaveBeenCalled();
    expect(result).toEqual({ running: true });
  });

  it('generateOllama() delegates to ollama generate', async () => {
    (ollamaHelper.generate as jest.Mock<any>).mockResolvedValue('response');
    const result = await service.generateOllama('test prompt', 'qwen2.5:0.5b');
    expect(ollamaHelper.generate).toHaveBeenCalledWith('test prompt', 'qwen2.5:0.5b');
    expect(result).toBe('response');
  });

  it('supportedModels getter returns SUPPORTED_MODELS', () => {
    expect(service.supportedModels).toEqual(['ollama/qwen2.5:0.5b', 'ollama/llama2']);
  });

  it('modelMetadata getter returns MODEL_METADATA', () => {
    expect(service.modelMetadata).toEqual({ 'qwen2.5:0.5b': { vramRequired: 1 } });
  });
});
