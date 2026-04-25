import {
  setActiveMissions,
  getActiveMissions,
  renderMissionBriefForPrompt,
  getMissionContextLastUpdatedAt,
  _resetMissionContextStateForTests,
  type MissionBrief,
} from '../mission-context-state';

const SAMPLE: MissionBrief[] = [
  {
    id: 'm1',
    name: 'ALS: cure',
    description: 'Find treatments for ALS',
    activeObjectives: [
      { type: 'find_compound', description: 'Drug repurposing' },
      { type: 'find_target', description: 'Molecular targets' },
    ],
  },
  {
    id: 'm2',
    name: 'Alzheimer: cure',
    description: 'Find treatments for Alzheimer',
    activeObjectives: [],
  },
];

describe('mission-context-state', () => {
  beforeEach(() => _resetMissionContextStateForTests());

  it('starts empty', () => {
    expect(getActiveMissions()).toEqual([]);
    expect(renderMissionBriefForPrompt()).toBe('');
  });

  it('caches the briefs and exposes a copy', () => {
    setActiveMissions(SAMPLE);
    expect(getActiveMissions()).toHaveLength(2);
    // Mutating the returned array shouldn't poison internal state.
    (getActiveMissions() as MissionBrief[]).pop();
    expect(getActiveMissions()).toHaveLength(2);
  });

  it('treats undefined / null payloads as empty', () => {
    setActiveMissions(undefined);
    expect(getActiveMissions()).toEqual([]);
    setActiveMissions(null);
    expect(getActiveMissions()).toEqual([]);
  });

  it('updates lastUpdatedAt each set', () => {
    expect(getMissionContextLastUpdatedAt()).toBe(0);
    setActiveMissions(SAMPLE);
    expect(getMissionContextLastUpdatedAt()).toBeGreaterThan(0);
  });

  describe('renderMissionBriefForPrompt', () => {
    it('renders a section per mission with objectives', () => {
      setActiveMissions(SAMPLE);
      const out = renderMissionBriefForPrompt();
      expect(out).toContain('ACTIVE MISSIONS');
      expect(out).toContain('ALS: cure');
      expect(out).toContain('Alzheimer: cure');
      expect(out).toContain('[find_compound] Drug repurposing');
    });

    it('omits the objectives bullet when none are active', () => {
      setActiveMissions([SAMPLE[1]]);
      const out = renderMissionBriefForPrompt();
      expect(out).toContain('Alzheimer: cure');
      expect(out).not.toContain('find_compound');
    });

    it('returns empty string when no missions cached', () => {
      expect(renderMissionBriefForPrompt()).toBe('');
    });
  });
});
