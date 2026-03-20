import { Module } from '@nestjs/common';
import { ModelCatalogHelper } from './model-catalog.js';
import { MutationEngineHelper } from './mutation-engine.js';
import { TrainerHelper } from './trainer.js';
import { ModelCatalogService } from './services/model-catalog.service.js';
import { MutationEngineService } from './services/mutation-engine.service.js';
import { TrainerService } from './services/trainer.service.js';

@Module({
  providers: [
    ModelCatalogHelper,
    MutationEngineHelper,
    TrainerHelper,
    ModelCatalogService,
    MutationEngineService,
    TrainerService,
  ],
  exports: [ModelCatalogService, MutationEngineService, TrainerService],
})
export class ModelModule {}
