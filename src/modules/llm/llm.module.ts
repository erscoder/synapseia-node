import { Module } from '@nestjs/common';
import { LlmProviderHelper } from '../../llm-provider.js';
import { OllamaHelper } from '../../ollama.js';
import { LlmService } from './llm.service.js';

@Module({
  providers: [LlmProviderHelper, OllamaHelper, LlmService],
  exports: [LlmService],
})
export class LlmModule {}
