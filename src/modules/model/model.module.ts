import { Module } from '@nestjs/common';
import { ModelCatalogService } from './model-catalog.service.js';
import { MutationEngineService } from './mutation-engine.service.js';
import { TrainerService } from './trainer.service.js';

@Module({
  providers: [ModelCatalogService, MutationEngineService, TrainerService],
  exports: [ModelCatalogService, MutationEngineService, TrainerService],
})
export class ModelModule {}
