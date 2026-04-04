/**
 * A2A Client Module
 * Sprint E — A2A Client for Synapseia Node
 *
 * Provides client-side A2A services for sending tasks to remote nodes.
 * A2AAuthService lives here to avoid circular dep: A2AModule → A2AClientModule → A2AAuthService.
 */

import { Module } from '@nestjs/common';
import { A2AClientService } from './a2a-client.service';
import { PeerRegistryService } from './peer-registry.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { PeerSelectorService } from './peer-selector.service';
import { A2AAuthService } from '../auth/a2a-auth.service';

@Module({
  providers: [
    A2AAuthService,   
    A2AClientService,
    PeerRegistryService,
    CircuitBreakerService,
    PeerSelectorService,
  ],
  exports: [
    A2AAuthService,
    A2AClientService,
    PeerRegistryService,
    PeerSelectorService,
    CircuitBreakerService,
  ],
})
export class A2AClientModule {}
