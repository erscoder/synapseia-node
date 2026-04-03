import { Module } from '@nestjs/common';
import { LlmProviderHelper } from './llm-provider';
import { OllamaHelper } from './ollama';

@Module({
  providers: [LlmProviderHelper, OllamaHelper],
  exports: [LlmProviderHelper, OllamaHelper],
})
export class LlmModule {}
