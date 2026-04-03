import { Module } from '@nestjs/common';
import { IdentityModule } from './modules/identity/identity.module';
import { HardwareModule } from './modules/hardware/hardware.module';
import { NodeConfigModule } from './modules/config/node-config.module';
import { HeartbeatModule } from './modules/heartbeat/heartbeat.module';
import { P2pModule } from './modules/p2p/p2p.module';
import { LlmModule } from './modules/llm/llm.module';
import { ModelModule } from './modules/model/model.module';
import { StakingModule } from './modules/staking/staking.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { InferenceModule } from './modules/inference/inference.module';
import { AgentModule } from './modules/agent/agent.module';
import { A2AModule } from './modules/a2a/a2a.module';

@Module({
  imports: [
    IdentityModule,
    HardwareModule,
    NodeConfigModule,
    HeartbeatModule,
    P2pModule,
    LlmModule,
    ModelModule,
    StakingModule,
    WalletModule,
    InferenceModule,
    AgentModule.register(),
    A2AModule,  // restored (ReviewAgentHelper dep removed from PeerReviewHandler)
  ],
})
export class AppModule {}
