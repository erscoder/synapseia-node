import { Module } from '@nestjs/common';
import { InferenceServerHelper } from './inference-server.js';
import { InferenceService } from './services/inference.service.js';

@Module({
  providers: [InferenceServerHelper, InferenceService],
  exports: [InferenceService],
})
export class InferenceModule {}
