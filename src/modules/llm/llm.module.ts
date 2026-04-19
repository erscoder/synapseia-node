import { Module } from '@nestjs/common';
import { LlmProviderHelper } from './llm-provider';
import { OllamaHelper } from './ollama';
import { SynapseiaServingClient } from './synapseia-serving-client';

@Module({
  providers: [LlmProviderHelper, OllamaHelper, SynapseiaServingClient],
  exports: [LlmProviderHelper, OllamaHelper, SynapseiaServingClient],
})
export class LlmModule {}
