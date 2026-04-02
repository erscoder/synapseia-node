import { Injectable } from '@nestjs/common';
import { AgentBrainHelper, type AgentBrain, type MemoryEntry, type JournalEntry } from '../agent-brain';

@Injectable()
export class AgentBrainService {
  constructor(private readonly agentBrainHelper: AgentBrainHelper) {}

  init(goals?: string[]): AgentBrain {
    return this.agentBrainHelper.initBrain(goals);
  }

  update(
    brain: AgentBrain,
    result: { valLoss: number; improved: boolean; mutation: string; lesson?: string },
  ): AgentBrain {
    return this.agentBrainHelper.updateBrain(brain, result);
  }

  getNextAction(brain: AgentBrain): 'explore' | 'improve' | 'rest' {
    return this.agentBrainHelper.getNextAction(brain);
  }

  getRecentMemories(
    brain: AgentBrain,
    maxEntries?: number,
    minImportance?: number,
  ): MemoryEntry[] {
    return this.agentBrainHelper.getRecentMemories(brain, maxEntries, minImportance);
  }

  getRecentJournal(brain: AgentBrain, maxEntries?: number): JournalEntry[] {
    return this.agentBrainHelper.getRecentJournal(brain, maxEntries);
  }
}
