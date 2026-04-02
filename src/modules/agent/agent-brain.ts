/**
 * Agent Brain cognitive loop (A18)
 * Manages memory, journaling, strategy, and learning from experiments
 *
 * PERSISTENCE (P1-3):
 * - Learnings are persisted to disk to survive session restarts
 * - Call saveBrainToDisk() after updateBrain() or saveResearchToBrain()
 * - initBrain() automatically loads from disk on startup
 */

import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import logger from '../../utils/logger';

export interface MemoryEntry {
  timestamp: number;
  type: 'experiment' | 'discovery' | 'failure';
  content: string;
  importance: number;
}

export interface JournalEntry {
  timestamp: number;
  action: string;
  outcome: string;
  lesson: string;
}

export interface AgentStrategy {
  explorationRate: number;
  focusArea: string;
  recentLessons: string[];
  consecutiveFailures: number;
}

export interface AgentBrain {
  goals: string[];
  memory: MemoryEntry[];
  journal: JournalEntry[];
  strategy: AgentStrategy;
  totalExperiments: number;
  bestResult: number | null;
}

@Injectable()
export class AgentBrainHelper {
  private readonly defaultGoals = ['minimize loss', 'discover novel architectures'];
  private get defaultBrainPath(): string {
    return process.env.AGENT_BRAIN_PATH || path.join(process.cwd(), 'data', 'agent-brain.json');
  }

  loadBrainFromDisk(filePath?: string): AgentBrain | null {
    const resolvedPath = filePath ?? this.defaultBrainPath;
    try {
      if (!fs.existsSync(resolvedPath)) {
        logger.debug(`[AgentBrain] No saved brain at ${resolvedPath}`);
        return null;
      }
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      const brain = JSON.parse(content) as AgentBrain;
      logger.log(`[AgentBrain] Loaded brain from disk: ${resolvedPath} (${brain.totalExperiments} experiments, ${brain.memory.length} memories)`);
      return brain;
    } catch (error) {
      logger.warn(`[AgentBrain] Failed to load brain from ${resolvedPath}:`, (error as Error).message);
      return null;
    }
  }

  saveBrainToDisk(brain: AgentBrain, filePath?: string): void {
    const resolvedPath = filePath ?? this.defaultBrainPath;
    try {
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(resolvedPath, JSON.stringify(brain, null, 2), 'utf-8');
      logger.debug(`[AgentBrain] Saved brain to disk: ${resolvedPath} (${brain.totalExperiments} experiments, ${brain.memory.length} memories)`);
    } catch (error) {
      logger.error(`[AgentBrain] Failed to save brain to ${resolvedPath}:`, (error as Error).message);
    }
  }

  persistBrain(brain: AgentBrain, filePath?: string): void {
    this.saveBrainToDisk(brain, filePath);
  }

  initBrain(goals?: string[], filePath?: string): AgentBrain {
    const loaded = this.loadBrainFromDisk(filePath);
    if (loaded) return loaded;

    return {
      goals: goals ? [...goals] : [...this.defaultGoals],
      memory: [],
      journal: [],
      strategy: {
        explorationRate: 0.5,
        focusArea: '',
        recentLessons: [],
        consecutiveFailures: 0,
      },
      totalExperiments: 0,
      bestResult: null,
    };
  }

  updateBrain(
    brain: AgentBrain,
    result: { valLoss: number; improved: boolean; mutation: string; lesson?: string },
  ): AgentBrain {
    brain.totalExperiments++;

    if (brain.bestResult === null || result.valLoss < brain.bestResult) {
      brain.bestResult = result.valLoss;
    }

    const memoryEntry: MemoryEntry = {
      timestamp: Date.now(),
      type: result.improved ? 'experiment' : 'failure',
      content: `Loss: ${result.valLoss}, Mutation: ${result.mutation}`,
      importance: result.improved ? Math.max(0.5, 1.0 - result.valLoss) : 0.2,
    };
    brain.memory.push(memoryEntry);

    const journalEntry: JournalEntry = {
      timestamp: Date.now(),
      action: result.mutation,
      outcome: result.improved ? 'improved' : 'worsened',
      lesson: result.lesson || (result.improved ? 'Mutation was successful' : 'Mutation did not improve'),
    };
    brain.journal.push(journalEntry);

    if (result.improved) {
      brain.strategy.explorationRate = Math.max(0.1, brain.strategy.explorationRate * 0.9);
      brain.strategy.consecutiveFailures = 0;
      if (result.lesson && !brain.strategy.recentLessons.includes(result.lesson)) {
        brain.strategy.recentLessons.push(result.lesson);
        if (brain.strategy.recentLessons.length > 10) {
          brain.strategy.recentLessons = brain.strategy.recentLessons.slice(-10);
        }
      }
    } else {
      brain.strategy.consecutiveFailures++;
      if (brain.strategy.consecutiveFailures >= 3) {
        brain.strategy.explorationRate = Math.min(1.0, brain.strategy.explorationRate * 1.2);
      }
    }

    if (brain.memory.length > 100) brain.memory = brain.memory.slice(-100);
    if (brain.journal.length > 100) brain.journal = brain.journal.slice(-100);

    return brain;
  }

  getNextAction(brain: AgentBrain): 'explore' | 'improve' | 'rest' {
    if (brain.strategy.consecutiveFailures > 10) return 'rest';
    if (brain.strategy.explorationRate > 0.5) return 'explore';
    return 'improve';
  }

  getRecentMemories(brain: AgentBrain, maxEntries = 5, minImportance = 0.3): MemoryEntry[] {
    return brain.memory
      .filter(m => m.importance >= minImportance)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, maxEntries);
  }

  getRecentJournal(brain: AgentBrain, maxEntries = 10): JournalEntry[] {
    return brain.journal.slice(-maxEntries).reverse();
  }
}
