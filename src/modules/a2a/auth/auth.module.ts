/**
 * A2A Client Module
 * Sprint E — A2A Client for Synapseia Node
 *
 * Provides client-side A2A services for sending tasks to remote nodes.
 * A2AAuthService lives here to avoid circular dep: A2AModule → A2AClientModule → A2AAuthService.
 */

import { Module } from '@nestjs/common';
import { A2AAuthService } from './a2a-auth.service';

@Module({
  providers: [
    A2AAuthService,   
  ],
  exports: [
    A2AAuthService,
  ],
})
export class AuthModule {}
