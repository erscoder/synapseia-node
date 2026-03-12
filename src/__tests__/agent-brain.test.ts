/**
 * Tests for agent-brain.ts (A18)
 * Tests for initBrain, updateBrain, getNextAction, memory management
 */

import {
  initBrain,
  updateBrain,
  getNextAction,
  getRecentMemories,
  getRecentJournal,
  type AgentBrain,
  type AgentStrategy,
} from '../agent-brain.js';

describe('initBrain', () => {
  it('should initialize brain with default goals', () => {
    const brain = initBrain();

    expect(brain.goals).toEqual(['minimize loss', 'discover novel architectures']);
    expect(brain.memory).toEqual([]);
    expect(brain.journal).toEqual([]);
    expect(brain.totalExperiments).toBe(0);
    expect(brain.bestResult).toBeNull();

    expect(brain.strategy.explorationRate).toBe(0.5);
    expect(brain.strategy.focusArea).toBe('');
    expect(brain.strategy.recentLessons).toEqual([]);
    expect(brain.strategy.consecutiveFailures).toBe(0);
  });

  it('should initialize brain with custom goals', () => {
    const customGoals = ['maximize accuracy', 'reduce latency', 'optimize memory'];
    const brain = initBrain(customGoals);

    expect(brain.goals).toEqual(customGoals);
    expect(brain.goals).not.toBe(customGoals); // Should be a copy
  });

  it('should create independent brain instances', () => {
    const brain1 = initBrain();
    const brain2 = initBrain();

    expect(brain1).not.toBe(brain2);
    expect(brain1.goals).not.toBe(brain2.goals);
  });
});

describe('updateBrain', () => {
  let brain: AgentBrain;

  beforeEach(() => {
    brain = initBrain();
  });

  it('should increment total experiments', () => {
    const updated = updateBrain(brain, {
      valLoss: 0.5,
      improved: true,
      mutation: 'test mutation',
    });

    expect(updated.totalExperiments).toBe(1);

    const updated2 = updateBrain(updated, {
      valLoss: 0.4,
      improved: true,
      mutation: 'test mutation 2',
    });

    expect(updated2.totalExperiments).toBe(2);
  });

  it('should update best result on improvement', () => {
    const updated = updateBrain(brain, {
      valLoss: 0.5,
      improved: true,
      mutation: 'mutation 1',
    });

    expect(updated.bestResult).toBe(0.5);

    const updated2 = updateBrain(updated, {
      valLoss: 0.3,
      improved: true,
      mutation: 'mutation 2',
    });

    expect(updated2.bestResult).toBe(0.3);
  });

  it('should not update best result on worse result', () => {
    const updated = updateBrain(brain, {
      valLoss: 0.5,
      improved: true,
      mutation: 'mutation 1',
    });

    expect(updated.bestResult).toBe(0.5);

    const updated2 = updateBrain(updated, {
      valLoss: 0.7,
      improved: false,
      mutation: 'mutation 2',
    });

    expect(updated2.bestResult).toBe(0.5);
  });

  it('should add memory entry', () => {
    const updated = updateBrain(brain, {
      valLoss: 0.3,
      improved: true,
      mutation: 'dropout 0.5',
    });

    expect(updated.memory).toHaveLength(1);
    expect(updated.memory[0].type).toBe('experiment');
    expect(updated.memory[0].content).toContain('0.3');
    expect(updated.memory[0].importance).toBeGreaterThan(0);
    expect(updated.memory[0].timestamp).toBeDefined();
  });

  it('should add failure memory entry', () => {
    const updated = updateBrain(brain, {
      valLoss: 0.9,
      improved: false,
      mutation: 'bad change',
    });

    expect(updated.memory).toHaveLength(1);
    expect(updated.memory[0].type).toBe('failure');
    expect(updated.memory[0].importance).toBe(0.2);
  });

  it('should calculate importance based on loss', () => {
    const updated1 = updateBrain(brain, {
      valLoss: 0.1,
      improved: true,
      mutation: 'good change',
    });

    const updated2 = updateBrain(brain, {
      valLoss: 0.9,
      improved: true,
      mutation: 'ok change',
    });

    expect(updated1.memory[0].importance).toBeGreaterThanOrEqual(updated2.memory[0].importance);
  });

  it('should add journal entry', () => {
    const updated = updateBrain(brain, {
      valLoss: 0.3,
      improved: true,
      mutation: 'test',
      lesson: 'Lesson learned',
    });

    expect(updated.journal).toHaveLength(1);
    expect(updated.journal[0].action).toBe('test');
    expect(updated.journal[0].outcome).toBe('improved');
    expect(updated.journal[0].lesson).toBe('Lesson learned');
  });

  it('should use default lesson if none provided', () => {
    const improved = updateBrain(brain, {
      valLoss: 0.3,
      improved: true,
      mutation: 'test',
    });

    expect(improved.journal[0].lesson).toBe('Mutation was successful');

    let currentBrain = brain;
    // Create new brain for worsened test
    currentBrain = initBrain();
    const worsened = updateBrain(currentBrain, {
      valLoss: 0.9,
      improved: false,
      mutation: 'test2',
    });

    expect(worsened.journal[0].lesson).toBe('Mutation did not improve');
  });

  it('should decrease exploration rate on improvement', () => {
    const updated = updateBrain(brain, {
      valLoss: 0.5,
      improved: true,
      mutation: 'test',
    });

    expect(updated.strategy.explorationRate).toBeLessThan(0.5);
    expect(updated.strategy.explorationRate).toBeCloseTo(0.45);
  });

  it('should not decrease exploration rate below 0.1', () => {
    let currentBrain = brain;
    for (let i = 0; i < 20; i++) {
      currentBrain = updateBrain(currentBrain, {
        valLoss: 0.5,
        improved: true,
        mutation: 'test',
      });
    }

    expect(currentBrain.strategy.explorationRate).toBeGreaterThanOrEqual(0.1);
  });

  it('should add lesson to recent lessons', () => {
    const updated = updateBrain(brain, {
      valLoss: 0.5,
      improved: true,
      mutation: 'test',
      lesson: 'Important lesson',
    });

    expect(updated.strategy.recentLessons).toContain('Important lesson');
  });

  it('should not add duplicate lessons', () => {
    let currentBrain = brain;
    currentBrain = updateBrain(currentBrain, {
      valLoss: 0.5,
      improved: true,
      mutation: 'test',
      lesson: 'Lesson A',
    });

    // Apply the same lesson again
    currentBrain = updateBrain(currentBrain, {
      valLoss: 0.4,
      improved: true,
      mutation: 'test2',
      lesson: 'Lesson A',
    });

    const count = currentBrain.strategy.recentLessons.filter((l) => l === 'Lesson A').length;
    expect(count).toBe(1);
  });

  it('should keep only last 10 lessons', () => {
    const lessonCount = 15;
    let currentBrain = brain;
    for (let i = 0; i < lessonCount; i++) {
      currentBrain = updateBrain(currentBrain, {
        valLoss: 0.5,
        improved: true,
        mutation: `test ${i}`,
        lesson: `Lesson ${i}`,
      });
    }

    expect(currentBrain.strategy.recentLessons).toHaveLength(10);
    expect(currentBrain.strategy.recentLessons).toContain(`Lesson ${14}`);
    expect(currentBrain.strategy.recentLessons).toContain(`Lesson ${10}`);
  });

  it('should increment consecutive failures on worsened result', () => {
    const updated = updateBrain(brain, {
      valLoss: 0.9,
      improved: false,
      mutation: 'bad',
    });

    expect(updated.strategy.consecutiveFailures).toBe(1);

    const updated2 = updateBrain(updated, {
      valLoss: 1.0,
      improved: false,
      mutation: 'worse',
    });

    expect(updated2.strategy.consecutiveFailures).toBe(2);
  });

  it('should reset consecutive failures on improvement', () => {
    let currentBrain = brain;
    currentBrain = updateBrain(currentBrain, {
      valLoss: 1.0,
      improved: false,
      mutation: 'bad',
    });

    expect(currentBrain.strategy.consecutiveFailures).toBe(1);

    currentBrain = updateBrain(currentBrain, {
      valLoss: 0.5,
      improved: true,
      mutation: 'good',
    });

    expect(currentBrain.strategy.consecutiveFailures).toBe(0);
  });

  it('should increase exploration rate after 3 consecutive failures', () => {
    let currentBrain = brain;
    currentBrain = updateBrain(currentBrain, {
      valLoss: 1.0,
      improved: false,
      mutation: 'fail1',
    });

    expect(currentBrain.strategy.explorationRate).toBe(0.5);

    currentBrain = updateBrain(currentBrain, {
      valLoss: 1.1,
      improved: false,
      mutation: 'fail2',
    });

    expect(currentBrain.strategy.explorationRate).toBe(0.5);

    currentBrain = updateBrain(currentBrain, {
      valLoss: 1.2,
      improved: false,
      mutation: 'fail3',
    });

    expect(currentBrain.strategy.explorationRate).toBeGreaterThan(0.5);
    expect(currentBrain.strategy.explorationRate).toBeCloseTo(0.6);
  });

  it('should not increase exploration rate above 1.0', () => {
    let currentBrain = brain;
    for (let i = 0; i < 20; i++) {
      currentBrain = updateBrain(currentBrain, {
        valLoss: 1.0,
        improved: false,
        mutation: `fail ${i}`,
      });
    }

    expect(currentBrain.strategy.explorationRate).toBeLessThanOrEqual(1.0);
  });

  it('should prune memory to 100 entries', () => {
    let currentBrain = brain;
    for (let i = 0; i < 150; i++) {
      currentBrain = updateBrain(currentBrain, {
        valLoss: 0.5,
        improved: true,
        mutation: `test ${i}`,
      });
    }

    expect(currentBrain.memory).toHaveLength(100);
  });

  it('should prune journal to 100 entries', () => {
    let currentBrain = brain;
    for (let i = 0; i < 150; i++) {
      currentBrain = updateBrain(currentBrain, {
        valLoss: 0.5,
        improved: true,
        mutation: `test ${i}`,
      });
    }

    expect(currentBrain.journal).toHaveLength(100);
  });
});

describe('getNextAction', () => {
  it('should return rest if consecutive failures > 10', () => {
    const brain: AgentBrain = {
      goals: [],
      memory: [],
      journal: [],
      strategy: {
        explorationRate: 0.5,
        focusArea: '',
        recentLessons: [],
        consecutiveFailures: 11,
      },
      totalExperiments: 0,
      bestResult: null,
    };

    const action = getNextAction(brain);
    expect(action).toBe('rest');
  });

  it('should explore if exploration rate > 0.5', () => {
    const brain: AgentBrain = {
      goals: [],
      memory: [],
      journal: [],
      strategy: {
        explorationRate: 0.7,
        focusArea: '',
        recentLessons: [],
        consecutiveFailures: 0,
      },
      totalExperiments: 0,
      bestResult: null,
    };

    const action = getNextAction(brain);
    expect(action).toBe('explore');
  });

  it('should improve if exploration rate <= 0.5', () => {
    const brain: AgentBrain = {
      goals: [],
      memory: [],
      journal: [],
      strategy: {
        explorationRate: 0.3,
        focusArea: '',
        recentLessons: [],
        consecutiveFailures: 0,
      },
      totalExperiments: 0,
      bestResult: null,
    };

    const action = getNextAction(brain);
    expect(action).toBe('improve');
  });

  it('should return explore on boundary (0.5)', () => {
    const brain: AgentBrain = {
      goals: [],
      memory: [],
      journal: [],
      strategy: {
        explorationRate: 0.51, // Slightly above 0.5
        focusArea: '',
        recentLessons: [],
        consecutiveFailures: 0,
      },
      totalExperiments: 0,
      bestResult: null,
    };

    const action = getNextAction(brain);
    expect(action).toBe('explore');
  });

  it('should return improve exactly at 0.5', () => {
    const brain: AgentBrain = {
      goals: [],
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

    const action = getNextAction(brain);
    expect(action).toBe('improve');
  });

  it('should prioritize rest over exploration', () => {
    const brain: AgentBrain = {
      goals: [],
      memory: [],
      journal: [],
      strategy: {
        explorationRate: 0.9,
        focusArea: '',
        recentLessons: [],
        consecutiveFailures: 15,
      },
      totalExperiments: 0,
      bestResult: null,
    };

    const action = getNextAction(brain);
    expect(action).toBe('rest');
  });
});

describe('getRecentMemories', () => {
  const brain: AgentBrain = {
    goals: [],
    memory: [
      {
        timestamp: 1,
        type: 'experiment',
        content: 'High importance',
        importance: 0.9,
      },
      {
        timestamp: 2,
        type: 'discovery',
        content: 'Medium importance',
        importance: 0.5,
      },
      {
        timestamp: 3,
        type: 'failure',
        content: 'Low importance',
        importance: 0.2,
      },
    ],
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

  it('should return memories sorted by importance', () => {
    const memories = getRecentMemories(brain, 3, 0);

    expect(memories[0].importance).toBe(0.9);
    expect(memories[1].importance).toBe(0.5);
    expect(memories[2].importance).toBe(0.2);
  });

  it('should filter by minimum importance', () => {
    const memories = getRecentMemories(brain, 10, 0.4);

    expect(memories).toHaveLength(2);
    expect(memories.every((m) => m.importance >= 0.4)).toBe(true);
  });

  it('should limit number of results', () => {
    const memories = getRecentMemories(brain, 2, 0);

    expect(memories).toHaveLength(2);
  });

  it('should return empty array for no memories', () => {
    const emptyBrain: AgentBrain = {
      ...brain,
      memory: [],
    };

    const memories = getRecentMemories(emptyBrain);

    expect(memories).toEqual([]);
  });

  it('should return default maxEntries when not specified', () => {
    const memories = getRecentMemories(brain);

    expect(memories.length).toBeLessThanOrEqual(3);
    expect(memories).toHaveLength(2); // Only 2 memories have importance >= 0.3
  });
});

describe('getRecentJournal', () => {
  it('should return recent journal entries in reverse order', () => {
    const brain: AgentBrain = {
      goals: [],
      memory: [],
      journal: [
        { timestamp: 1, action: 'a', outcome: 'x', lesson: 'l1' },
        { timestamp: 2, action: 'b', outcome: 'y', lesson: 'l2' },
        { timestamp: 3, action: 'c', outcome: 'z', lesson: 'l3' },
      ],
      strategy: {
        explorationRate: 0.5,
        focusArea: '',
        recentLessons: [],
        consecutiveFailures: 0,
      },
      totalExperiments: 0,
      bestResult: null,
    };

    const journal = getRecentJournal(brain, 2);

    expect(journal).toHaveLength(2);
    expect(journal[0].timestamp).toBe(3);
    expect(journal[1].timestamp).toBe(2);
  });

  it('should return all entries if maxEntries > journal length', () => {
    const brain: AgentBrain = {
      goals: [],
      memory: [],
      journal: [
        { timestamp: 1, action: 'a', outcome: 'x', lesson: 'l1' },
        { timestamp: 2, action: 'b', outcome: 'y', lesson: 'l2' },
        { timestamp: 3, action: 'c', outcome: 'z', lesson: 'l3' },
      ],
      strategy: {
        explorationRate: 0.5,
        focusArea: '',
        recentLessons: [],
        consecutiveFailures: 0,
      },
      totalExperiments: 0,
      bestResult: null,
    };

    const journal = getRecentJournal(brain, 10);

    expect(journal).toHaveLength(3);
  });

  it('should return empty array for empty journal', () => {
    const brain: AgentBrain = {
      goals: [],
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

    const journal = getRecentJournal(brain);

    expect(journal).toEqual([]);
  });

  it('should use default maxEntries when not specified', () => {
    let brain: AgentBrain = initBrain();
    for (let i = 0; i < 15; i++) {
      brain = updateBrain(brain, {
        valLoss: 0.5,
        improved: true,
        mutation: `test ${i}`,
      });
    }

    const journal = getRecentJournal(brain);

    expect(journal).toHaveLength(10);
  });
});
