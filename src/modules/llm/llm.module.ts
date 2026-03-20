import { Module } from '@nestjs/common';
import { LlmProviderHelper } from './helpers/llm-provider.js';
import { OllamaHelper } from './helpers/ollama.js';
import { LlmService } from './llm.service.js';

@Module({
  providers: [LlmProviderHelper, OllamaHelper, LlmService],
  exports: [LlmService],
})
export class LlmModule {}
