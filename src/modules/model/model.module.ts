import { Module } from '@nestjs/common';
import { ModelCatalogHelper } from './helpers/model-catalog.js';
import { MutationEngineHelper } from './helpers/mutation-engine.js';
import { TrainerHelper } from './helpers/trainer.js';
import { ModelCatalogService } from './model-catalog.service.js';
import { MutationEngineService } from './mutation-engine.service.js';
import { TrainerService } from './trainer.service.js';

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
