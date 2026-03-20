import { Module } from '@nestjs/common';
import { IdentityService } from './identity.service.js';

@Module({
  providers: [IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
