import { Injectable } from '@nestjs/common';
import {
  initBrain,
  updateBrain,
  getNextAction,
  getRecentMemories,
  getRecentJournal,
  type AgentBrain,
  type MemoryEntry,
  type JournalEntry,
} from '../../agent-brain.js';

@Injectable()
export class AgentBrainService {
  init(goals?: string[]): AgentBrain {
    return initBrain(goals);
  }

  update(
    brain: AgentBrain,
    result: { valLoss: number; improved: boolean; mutation: string; lesson?: string },
  ): AgentBrain {
    return updateBrain(brain, result);
  }

  getNextAction(brain: AgentBrain): 'explore' | 'improve' | 'rest' {
    return getNextAction(brain);
  }

  getRecentMemories(
    brain: AgentBrain,
    maxEntries?: number,
    minImportance?: number,
  ): MemoryEntry[] {
    return getRecentMemories(brain, maxEntries, minImportance);
  }

  getRecentJournal(brain: AgentBrain, maxEntries?: number): JournalEntry[] {
    return getRecentJournal(brain, maxEntries);
  }
}
