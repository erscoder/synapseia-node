import { Module } from '@nestjs/common';
import { IdentityHelper } from './identity';
import { IdentityService } from './services/identity.service';

@Module({
  providers: [IdentityHelper, IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
