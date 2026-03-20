import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { LlmService } from '../llm.service.js';
import { LlmProviderHelper } from '../helpers/llm-provider.js';
import { OllamaHelper } from '../helpers/ollama.js';

const mockModel = { provider: 'ollama', modelId: 'qwen2.5:0.5b' };

describe('LlmService', () => {
  let service: LlmService;
  let llmProviderHelper: jest.Mocked<LlmProviderHelper>;
  let ollamaHelper: jest.Mocked<OllamaHelper>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        LlmService,
        {
          provide: LlmProviderHelper,
          useValue: {
            parseModel: jest.fn(),
            checkLLM: jest.fn(),
            generateLLM: jest.fn(),
            toErrorMessage: jest.fn(),
            getOptionalString: jest.fn(),
          },
        },
        {
          provide: OllamaHelper,
          useValue: {
            checkOllama: jest.fn(),
            generate: jest.fn(),
            pullModel: jest.fn(),
            ensureModel: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<LlmService>(LlmService);
    llmProviderHelper = module.get(LlmProviderHelper);
    ollamaHelper = module.get(OllamaHelper);
  });

  it('parse() delegates to parseModel', () => {
    llmProviderHelper.parseModel.mockReturnValue(mockModel as any);
    const result = service.parse('ollama/qwen2.5:0.5b');
    expect(llmProviderHelper.parseModel).toHaveBeenCalledWith('ollama/qwen2.5:0.5b');
    expect(result).toBe(mockModel);
  });

  it('parse() returns null for invalid model', () => {
    llmProviderHelper.parseModel.mockReturnValue(null);
    const result = service.parse('invalid');
    expect(result).toBeNull();
  });

  it('check() delegates to checkLLM', async () => {
    const status = { available: true };
    llmProviderHelper.checkLLM.mockResolvedValue(status as any);
    const result = await service.check(mockModel as any);
    expect(llmProviderHelper.checkLLM).toHaveBeenCalledWith(mockModel, undefined);
    expect(result).toBe(status);
  });

  it('check() passes config', async () => {
    llmProviderHelper.checkLLM.mockResolvedValue({ available: false } as any);
    const config = { llmUrl: 'http://custom.api' };
    await service.check(mockModel as any, config as any);
    expect(llmProviderHelper.checkLLM).toHaveBeenCalledWith(mockModel, config);
  });

  it('generate() delegates to generateLLM', async () => {
    llmProviderHelper.generateLLM.mockResolvedValue('result text');
    const result = await service.generate(mockModel as any, 'hello');
    expect(llmProviderHelper.generateLLM).toHaveBeenCalledWith(mockModel, 'hello', undefined);
    expect(result).toBe('result text');
  });

  it('generate() passes config', async () => {
    llmProviderHelper.generateLLM.mockResolvedValue('text');
    const config = { llmUrl: 'http://api' };
    await service.generate(mockModel as any, 'prompt', config as any);
    expect(llmProviderHelper.generateLLM).toHaveBeenCalledWith(mockModel, 'prompt', config);
  });

  it('checkOllama() delegates to ollama checkOllama', async () => {
    ollamaHelper.checkOllama.mockResolvedValue({ running: true } as any);
    const result = await service.checkOllama();
    expect(ollamaHelper.checkOllama).toHaveBeenCalled();
    expect(result).toEqual({ running: true });
  });

  it('generateOllama() delegates to ollama generate', async () => {
    ollamaHelper.generate.mockResolvedValue('response');
    const result = await service.generateOllama('test prompt', 'qwen2.5:0.5b');
    expect(ollamaHelper.generate).toHaveBeenCalledWith('test prompt', 'qwen2.5:0.5b');
    expect(result).toBe('response');
  });

  it('supportedModels getter returns SUPPORTED_MODELS', () => {
    expect(service.supportedModels).toBeDefined();
    expect(typeof service.supportedModels).toBe('object');
  });

  it('modelMetadata getter returns MODEL_METADATA', () => {
    expect(service.modelMetadata).toBeDefined();
    expect(typeof service.modelMetadata).toBe('object');
  });
});
