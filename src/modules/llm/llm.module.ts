import { Module } from '@nestjs/common';
import { LlmProviderHelper } from './llm-provider';
import { OllamaHelper } from './ollama';
import { LlmService } from './services/llm.service';

@Module({
  providers: [LlmProviderHelper, OllamaHelper, LlmService],
  exports: [LlmService],
})
export class LlmModule {}
