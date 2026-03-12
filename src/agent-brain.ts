/**
 * Agent Brain cognitive loop (A18)
 * Manages memory, journaling, strategy, and learning from experiments
 */

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

/**
 * Initialize a new agent brain
 */
export function initBrain(goals?: string[]): AgentBrain {
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
