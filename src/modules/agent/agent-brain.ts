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
import logger from '../../utils/logger.js';

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

const DEFAULT_GOALS = ['minimize loss', 'discover novel architectures'];
const DEFAULT_BRAIN_PATH = process.env.AGENT_BRAIN_PATH || path.join(process.cwd(), 'data', 'agent-brain.json');

/**
 * Load brain from disk
 * Returns null if file does not exist
 */
export function loadBrainFromDisk(filePath: string = DEFAULT_BRAIN_PATH): AgentBrain | null {
  try {
    if (!fs.existsSync(filePath)) {
      logger.debug(`[AgentBrain] No saved brain at ${filePath}`);
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const brain = JSON.parse(content) as AgentBrain;
    logger.log(`[AgentBrain] Loaded brain from disk: ${filePath} (${brain.totalExperiments} experiments, ${brain.memory.length} memories)`);
    return brain;
  } catch (error) {
    logger.warn(`[AgentBrain] Failed to load brain from ${filePath}:`, (error as Error).message);
    return null;
  }
}

/**
 * Save brain to disk
 * Creates parent directory if it does not exist
 */
export function saveBrainToDisk(brain: AgentBrain, filePath: string = DEFAULT_BRAIN_PATH): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, JSON.stringify(brain, null, 2), 'utf-8');
    logger.debug(`[AgentBrain] Saved brain to disk: ${filePath} (${brain.totalExperiments} experiments, ${brain.memory.length} memories)`);
  } catch (error) {
    logger.error(`[AgentBrain] Failed to save brain to ${filePath}:`, (error as Error).message);
  }
}

/**
 * Persist brain to disk with optional path override
 */
export function persistBrain(brain: AgentBrain, filePath?: string): void {
  saveBrainToDisk(brain, filePath || DEFAULT_BRAIN_PATH);
}

/**
 * Initialize a new agent brain
 * Loads from disk first if available, otherwise creates fresh
 */
export function initBrain(goals?: string[], filePath?: string): AgentBrain {
  const resolvedPath = filePath || DEFAULT_BRAIN_PATH;
  
  // Try to load from disk first
  const loaded = loadBrainFromDisk(resolvedPath);
  if (loaded) {
    return loaded;
  }

  // Create fresh brain
  return {
    goals: goals ? [...goals] : [...DEFAULT_GOALS],
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

/**
 * Update brain based on experiment result
 */
export function updateBrain(
  brain: AgentBrain,
  result: {
    valLoss: number;
    improved: boolean;
    mutation: string;
    lesson?: string;
  },
): AgentBrain {
  // Increment experiment counter
  brain.totalExperiments++;

  // Track best result
  if (brain.bestResult === null || result.valLoss < brain.bestResult) {
    brain.bestResult = result.valLoss;
  }

  // Add to memory based on outcome
  const memoryEntry: MemoryEntry = {
    timestamp: Date.now(),
    type: result.improved ? 'experiment' : 'failure',
    content: `Loss: ${result.valLoss}, Mutation: ${result.mutation}`,
    importance: result.improved ? Math.max(0.5, 1.0 - result.valLoss) : 0.2,
  };
  brain.memory.push(memoryEntry);

  // Add to journal
  const journalEntry: JournalEntry = {
    timestamp: Date.now(),
    action: result.mutation,
    outcome: result.improved ? 'improved' : 'worsened',
    lesson:
      result.lesson ||
      (result.improved ? 'Mutation was successful' : 'Mutation did not improve'),
  };
  brain.journal.push(journalEntry);

  // Update strategy based on result
  if (result.improved) {
    // Improvement: decrease exploration rate
    brain.strategy.explorationRate = Math.max(0.1, brain.strategy.explorationRate * 0.9);
    brain.strategy.consecutiveFailures = 0;

    // Add to recent lessons
    if (result.lesson && !brain.strategy.recentLessons.includes(result.lesson)) {
      brain.strategy.recentLessons.push(result.lesson);
      // Keep only last 10 lessons
      if (brain.strategy.recentLessons.length > 10) {
        brain.strategy.recentLessons = brain.strategy.recentLessons.slice(-10);
      }
    }
  } else {
    // No improvement: increment consecutive failures
    brain.strategy.consecutiveFailures++;

    // Increase exploration rate if many consecutive failures
    if (brain.strategy.consecutiveFailures >= 3) {
      brain.strategy.explorationRate = Math.min(1.0, brain.strategy.explorationRate * 1.2);
    }
  }

  // Prune memory if too large (keep last 100 entries)
  if (brain.memory.length > 100) {
    brain.memory = brain.memory.slice(-100);
  }
  if (brain.journal.length > 100) {
    brain.journal = brain.journal.slice(-100);
  }

  return brain;
}

/**
 * Get next action based on brain state
 */
export function getNextAction(brain: AgentBrain): 'explore' | 'improve' | 'rest' {
  // Rest if too many consecutive failures
  if (brain.strategy.consecutiveFailures > 10) {
    return 'rest';
  }

  // Explore if exploration rate is high
  if (brain.strategy.explorationRate > 0.5) {
    return 'explore';
  }

  // Otherwise improve
  return 'improve';
}

/**
 * Get recent important memories
 */
export function getRecentMemories(
  brain: AgentBrain,
  maxEntries: number = 5,
  minImportance: number = 0.3,
): MemoryEntry[] {
  const recentMemories = brain.memory
    .filter((m) => m.importance >= minImportance)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, maxEntries);

  return recentMemories;
}

/**
 * Get recent journal entries
 */
export function getRecentJournal(brain: AgentBrain, maxEntries: number = 10): JournalEntry[] {
  return brain.journal.slice(-maxEntries).reverse();
}

// ---------------------------------------------------------------------------
// Injectable helper class — wraps the standalone functions for NestJS DI
// ---------------------------------------------------------------------------

@Injectable()
export class AgentBrainHelper {
  initBrain(goals?: string[], filePath?: string): AgentBrain {
    return initBrain(goals, filePath);
  }

  updateBrain(
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

  loadBrainFromDisk(filePath?: string): AgentBrain | null {
    return loadBrainFromDisk(filePath);
  }

  saveBrainToDisk(brain: AgentBrain, filePath?: string): void {
    return saveBrainToDisk(brain, filePath);
  }

  persistBrain(brain: AgentBrain, filePath?: string): void {
    return persistBrain(brain, filePath);
  }
}
