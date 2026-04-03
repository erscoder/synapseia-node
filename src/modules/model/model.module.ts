import { Module } from '@nestjs/common';
import { ModelCatalogHelper } from './model-catalog';
import { MutationEngineHelper } from './mutation-engine';
import { TrainerHelper } from './trainer';

@Module({
  providers: [
    ModelCatalogHelper,
    MutationEngineHelper,
    TrainerHelper,
  ],
  exports: [ModelCatalogHelper, MutationEngineHelper, TrainerHelper],
})
export class ModelModule {}
