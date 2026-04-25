/**
 * Stores the most recent active-mission brief received from the coordinator
 * via the `round.opened` WebSocket event. Reads the brief into the medical
 * researcher prompt so generation targets the current goals instead of
 * producing off-topic medical content (audit 2026-04-25, Bucket C1).
 *
 * Module-level singleton because RoundListenerHelper (Nest DI) writes it
 * and ResearcherNode (also Nest DI but a separate boot graph in tests)
 * reads it. Cheap and stateless; tests reset via the helper.
 */

export interface MissionBrief {
  id: string;
  name: string;
  description: string;
  activeObjectives: Array<{ type: string; description: string }>;
}

let missions: MissionBrief[] = [];
let lastUpdatedAt = 0;

export function setActiveMissions(briefs: MissionBrief[] | undefined | null): void {
  missions = Array.isArray(briefs) ? briefs.slice() : [];
  lastUpdatedAt = Date.now();
}

export function getActiveMissions(): readonly MissionBrief[] {
  // Return a fresh slice — callers that mutate via `as MissionBrief[]` cast
  // can't poison the cached state.
  return missions.slice();
}

export function getMissionContextLastUpdatedAt(): number {
  return lastUpdatedAt;
}

/**
 * Render a compact text block suitable for prompt injection. Returns an
 * empty string when no missions are active so callers can append blindly
 * without producing a stray "ACTIVE MISSIONS:" header.
 */
export function renderMissionBriefForPrompt(): string {
  if (missions.length === 0) return '';
  const blocks = missions.map((m) => {
    const objectives = m.activeObjectives
      .map((o) => `    - [${o.type}] ${o.description}`)
      .join('\n');
    return `  • ${m.name}\n    ${m.description}${objectives ? `\n${objectives}` : ''}`;
  });
  return `ACTIVE MISSIONS (target your discovery toward at least one):\n${blocks.join('\n\n')}`;
}

/** Test-only reset helper. */
export function _resetMissionContextStateForTests(): void {
  missions = [];
  lastUpdatedAt = 0;
}
