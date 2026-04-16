import { Module } from '@nestjs/common';
import { WorkOrderCoordinatorHelper } from './work-order.coordinator';
import { IdentityModule } from '../../identity/identity.module';

/**
 * Shared provider for `WorkOrderCoordinatorHelper` so both `WorkOrderModule`
 * and `ToolsModule` get the SAME instance via DI.
 *
 * Before this split, both modules declared the helper in their own
 * `providers` array — NestJS created two independent singletons, each
 * ran `onModuleInit`, and the "Ed25519 signing enabled for peerId …"
 * log fired twice at startup. The duplicate was not just cosmetic:
 * anything that relied on the helper's internal state (keypair, peerId)
 * would diverge between module scopes.
 *
 * Kept minimal on purpose — only the coordinator helper + its `IdentityService`
 * dep live here. Both consumer modules import this module and get the
 * helper transparently through the exports.
 */
@Module({
  imports: [IdentityModule],
  providers: [WorkOrderCoordinatorHelper],
  exports: [WorkOrderCoordinatorHelper],
})
export class WorkOrderCoordinatorModule {}
