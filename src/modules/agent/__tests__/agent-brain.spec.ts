import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentBrainHelper, type AgentBrain } from '../agent-brain';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeBrain(overrides: Partial<AgentBrain> = {}): AgentBrain {
  return {
    goals: ['minimize loss'],
    memory: [],
    journal: [],
    strategy: { explorationRate: 0.5, focusArea: '', recentLessons: [], consecutiveFailures: 0 },
    totalExperiments: 0,
    bestResult: null,
    ...overrides,
  };
}

// ── AgentBrainHelper ──────────────────────────────────────────────────────────

describe('AgentBrainHelper', () => {
  let helper: AgentBrainHelper;
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    helper = new AgentBrainHelper();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-brain-test-'));
    tmpFile = path.join(tmpDir, 'brain.json');
    process.env.AGENT_BRAIN_PATH = tmpFile;
  });

  afterEach(() => {
    delete process.env.AGENT_BRAIN_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── initBrain ──────────────────────────────────────────────────────────────

  describe('initBrain()', () => {
    it('returns fresh brain when no file exists', () => {
      const brain = helper.initBrain();
      expect(brain.goals).toEqual(['minimize loss', 'discover novel architectures']);
      expect(brain.memory).toHaveLength(0);
      expect(brain.totalExperiments).toBe(0);
      expect(brain.bestResult).toBeNull();
    });

    it('accepts custom goals', () => {
      const brain = helper.initBrain(['goal-a', 'goal-b']);
      expect(brain.goals).toEqual(['goal-a', 'goal-b']);
    });

    it('loads from disk if file exists', () => {
      const saved = makeBrain({ totalExperiments: 7, bestResult: 0.23 });
      fs.writeFileSync(tmpFile, JSON.stringify(saved));
      const brain = helper.initBrain();
      expect(brain.totalExperiments).toBe(7);
      expect(brain.bestResult).toBeCloseTo(0.23);
    });

    it('returns fresh brain when disk file is corrupted', () => {
      fs.writeFileSync(tmpFile, 'not-json{{');
      const brain = helper.initBrain();
      expect(brain.totalExperiments).toBe(0);
    });
  });

  // ── saveBrainToDisk / loadBrainFromDisk ───────────────────────────────────

  describe('saveBrainToDisk() + loadBrainFromDisk()', () => {
    it('round-trips brain to disk', () => {
      const brain = makeBrain({ totalExperiments: 3 });
      helper.saveBrainToDisk(brain, tmpFile);
      const loaded = helper.loadBrainFromDisk(tmpFile);
      expect(loaded).not.toBeNull();
      expect(loaded!.totalExperiments).toBe(3);
    });

    it('creates missing directories automatically', () => {
      const deepPath = path.join(tmpDir, 'a', 'b', 'c', 'brain.json');
      helper.saveBrainToDisk(makeBrain(), deepPath);
      expect(fs.existsSync(deepPath)).toBe(true);
    });

    it('loadBrainFromDisk returns null when file missing', () => {
      const result = helper.loadBrainFromDisk('/nonexistent/path/brain.json');
      expect(result).toBeNull();
    });
  });

  // ── updateBrain ───────────────────────────────────────────────────────────

  describe('updateBrain()', () => {
    it('increments totalExperiments', () => {
      const brain = makeBrain();
      const updated = helper.updateBrain(brain, { valLoss: 0.4, improved: true, mutation: 'lr' });
      expect(updated.totalExperiments).toBe(1);
    });

    it('updates bestResult on improvement', () => {
      const brain = makeBrain({ bestResult: 0.5 });
      helper.updateBrain(brain, { valLoss: 0.3, improved: true, mutation: 'lr' });
      expect(brain.bestResult).toBeCloseTo(0.3);
    });

    it('does not update bestResult when loss is higher', () => {
      const brain = makeBrain({ bestResult: 0.2 });
      helper.updateBrain(brain, { valLoss: 0.9, improved: false, mutation: 'lr' });
      expect(brain.bestResult).toBeCloseTo(0.2);
    });

    it('adds memory entry of type experiment on success', () => {
      const brain = makeBrain();
      helper.updateBrain(brain, { valLoss: 0.3, improved: true, mutation: 'dropout' });
      expect(brain.memory[0].type).toBe('experiment');
    });

    it('adds memory entry of type failure on no improvement', () => {
      const brain = makeBrain();
      helper.updateBrain(brain, { valLoss: 0.9, improved: false, mutation: 'dropout' });
      expect(brain.memory[0].type).toBe('failure');
    });

    it('decreases explorationRate on consecutive improvements', () => {
      const brain = makeBrain({ strategy: { explorationRate: 1.0, focusArea: '', recentLessons: [], consecutiveFailures: 0 } });
      helper.updateBrain(brain, { valLoss: 0.3, improved: true, mutation: 'lr' });
      expect(brain.strategy.explorationRate).toBeLessThan(1.0);
    });

    it('increases explorationRate after 3 consecutive failures', () => {
      const brain = makeBrain({ strategy: { explorationRate: 0.5, focusArea: '', recentLessons: [], consecutiveFailures: 2 } });
      helper.updateBrain(brain, { valLoss: 0.9, improved: false, mutation: 'lr' });
      expect(brain.strategy.explorationRate).toBeGreaterThan(0.5);
    });

    it('caps memory at 100 entries', () => {
      const brain = makeBrain({ memory: Array.from({ length: 100 }, (_, i) => ({ timestamp: i, type: 'experiment' as const, content: 'x', importance: 0.5 })) });
      helper.updateBrain(brain, { valLoss: 0.3, improved: true, mutation: 'lr' });
      expect(brain.memory).toHaveLength(100);
    });

    it('adds custom lesson to journal and strategy', () => {
      const brain = makeBrain();
      helper.updateBrain(brain, { valLoss: 0.2, improved: true, mutation: 'batch', lesson: 'bigger batch helps' });
      expect(brain.strategy.recentLessons).toContain('bigger batch helps');
      expect(brain.journal[0].lesson).toBe('bigger batch helps');
    });
  });

  // ── getNextAction ─────────────────────────────────────────────────────────

  describe('getNextAction()', () => {
    it('returns explore when explorationRate > 0.5', () => {
      expect(helper.getNextAction(makeBrain({ strategy: { explorationRate: 0.8, focusArea: '', recentLessons: [], consecutiveFailures: 0 } }))).toBe('explore');
    });

    it('returns improve when explorationRate <= 0.5', () => {
      expect(helper.getNextAction(makeBrain({ strategy: { explorationRate: 0.3, focusArea: '', recentLessons: [], consecutiveFailures: 0 } }))).toBe('improve');
    });

    it('returns rest after > 10 consecutive failures', () => {
      expect(helper.getNextAction(makeBrain({ strategy: { explorationRate: 0.8, focusArea: '', recentLessons: [], consecutiveFailures: 11 } }))).toBe('rest');
    });
  });

  // ── getRecentMemories ─────────────────────────────────────────────────────

  describe('getRecentMemories()', () => {
    it('returns memories sorted by importance descending', () => {
      const brain = makeBrain({
        memory: [
          { timestamp: 1, type: 'experiment', content: 'low', importance: 0.3 },
          { timestamp: 2, type: 'experiment', content: 'high', importance: 0.9 },
          { timestamp: 3, type: 'experiment', content: 'mid', importance: 0.6 },
        ],
      });
      const result = helper.getRecentMemories(brain, 5, 0.1);
      expect(result[0].importance).toBe(0.9);
      expect(result[1].importance).toBe(0.6);
    });

    it('filters by minImportance', () => {
      const brain = makeBrain({
        memory: [
          { timestamp: 1, type: 'failure', content: 'ignored', importance: 0.1 },
          { timestamp: 2, type: 'experiment', content: 'kept', importance: 0.8 },
        ],
      });
      const result = helper.getRecentMemories(brain, 5, 0.3);
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('kept');
    });

    it('respects maxEntries', () => {
      const brain = makeBrain({
        memory: Array.from({ length: 10 }, (_, i) => ({ timestamp: i, type: 'experiment' as const, content: `m${i}`, importance: 0.5 })),
      });
      expect(helper.getRecentMemories(brain, 3, 0.0)).toHaveLength(3);
    });
  });

  // ── getRecentJournal ──────────────────────────────────────────────────────

  describe('getRecentJournal()', () => {
    it('returns last N entries in reverse order', () => {
      const brain = makeBrain({
        journal: [
          { timestamp: 1, action: 'a1', outcome: 'ok', lesson: '' },
          { timestamp: 2, action: 'a2', outcome: 'ok', lesson: '' },
          { timestamp: 3, action: 'a3', outcome: 'ok', lesson: '' },
        ],
      });
      const result = helper.getRecentJournal(brain, 2);
      expect(result[0].action).toBe('a3');
      expect(result[1].action).toBe('a2');
    });
  });

  // ── persistBrain alias ────────────────────────────────────────────────────

  it('persistBrain() is an alias for saveBrainToDisk()', () => {
    const spy = jest.spyOn(helper, 'saveBrainToDisk');
    const brain = makeBrain();
    helper.persistBrain(brain, tmpFile);
    expect(spy).toHaveBeenCalledWith(brain, tmpFile);
  });
});
