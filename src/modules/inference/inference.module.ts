import { Module } from '@nestjs/common';
import { InferenceServerHelper } from './inference-server';
import { InferenceService } from './services/inference.service';

@Module({
  providers: [InferenceServerHelper, InferenceService],
  exports: [InferenceService],
})
export class InferenceModule {}
