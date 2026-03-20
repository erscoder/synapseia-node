import { Module } from '@nestjs/common';
import { IdentityHelper } from './identity.js';
import { IdentityService } from './services/identity.service.js';

@Module({
  providers: [IdentityHelper, IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
