import { Module } from '@nestjs/common';
import { IdentityHelper } from './helpers/identity.js';
import { IdentityService } from './identity.service.js';

@Module({
  providers: [IdentityHelper, IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
