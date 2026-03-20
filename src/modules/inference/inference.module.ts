import { Module } from '@nestjs/common';
import { InferenceServerHelper } from './helpers/inference-server.js';
import { InferenceService } from './inference.service.js';

@Module({
  providers: [InferenceServerHelper, InferenceService],
  exports: [InferenceService],
})
export class InferenceModule {}
