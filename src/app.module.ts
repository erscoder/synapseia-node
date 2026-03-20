import { Module } from '@nestjs/common';
import { IdentityModule } from './modules/identity/identity.module.js';
import { HardwareModule } from './modules/hardware/hardware.module.js';
import { NodeConfigModule } from './modules/config/node-config.module.js';
import { HeartbeatModule } from './modules/heartbeat/heartbeat.module.js';
import { P2pModule } from './modules/p2p/p2p.module.js';
import { LlmModule } from './modules/llm/llm.module.js';
import { ModelModule } from './modules/model/model.module.js';
import { StakingModule } from './modules/staking/staking.module.js';
import { WalletModule } from './modules/wallet/wallet.module.js';
import { InferenceModule } from './modules/inference/inference.module.js';
import { AgentModule } from './modules/agent/agent.module.js';

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
    AgentModule,
  ],
})
export class AppModule {}
