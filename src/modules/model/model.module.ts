import { Module } from '@nestjs/common';
import { ModelCatalogHelper } from './model-catalog';
import { MutationEngineHelper } from './mutation-engine';
import { TrainerHelper } from './trainer';
import { ModelCatalogService } from './services/model-catalog.service';
import { MutationEngineService } from './services/mutation-engine.service';
import { TrainerService } from './services/trainer.service';

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
