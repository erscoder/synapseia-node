import { Module, OnModuleInit } from '@nestjs/common';
import { ModelCatalogHelper } from './model-catalog';
import { MutationEngineHelper } from './mutation-engine';
import { TrainerHelper } from './trainer';
import { ActiveModelSubscriber } from './active-model-subscriber';
import { SynapseiaServingClient } from '../llm/synapseia-serving-client';

@Module({
  providers: [
    ModelCatalogHelper,
    MutationEngineHelper,
    TrainerHelper,
    ActiveModelSubscriber,
    SynapseiaServingClient,
  ],
  exports: [
    ModelCatalogHelper,
    MutationEngineHelper,
    TrainerHelper,
    ActiveModelSubscriber,
    SynapseiaServingClient,
  ],
})
export class ModelModule implements OnModuleInit {
  constructor(private readonly subscriber: ActiveModelSubscriber) {}
  onModuleInit(): void {
    // F3-P2 — polling starts immediately; tick is safe when no active
    // model is published (returns 'no-active'). Operators register a
    // swap hook via `subscriber.setSwapHook(...)` AND run their local
    // llama.cpp / vLLM runtime to actually serve Synapseia traffic.
    this.subscriber.start();
  }
}
