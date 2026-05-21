import { describe, it, expect } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { NodesModule } from '../nodes.module';
import { ExecuteResearchNode } from '../execute-research';

/**
 * Real Nest DI regression guard (P27 pattern).
 *
 * `ExecuteResearchNode` injects SearchCorpusTool, QueryKgTool and
 * GenerateEmbeddingTool directly through its constructor. Those tools live in
 * `ToolsModule`; `NodesModule` only imports `ToolsModule`, so they can only be
 * resolved when `ToolsModule.exports` lists them. A previous refactor left the
 * exports as `[ToolRegistry, ToolRunnerService]`, which boot-crashed with:
 *   "Nest can't resolve dependencies of the ExecuteResearchNode (...).
 *    argument SearchCorpusTool at index [5] is NOT available in the
 *    NodesModule module."
 *
 * The tsup build returns exit 0 without checking the DI graph, and the
 * existing node specs instantiate the nodes via manual `new ExecuteResearchNode(...)`,
 * so neither path ever exercised real Nest wiring of NodesModule against
 * ToolsModule.exports. This spec compiles the actual module graph (including
 * the transitive WorkOrderModule / ToolsModule -> A2AClientModule /
 * IdentityModule / WorkOrderCoordinatorModule imports) so the DI graph is
 * validated for real. The full node app boots with `--help` locally without
 * any DB/network, so a plain compile() is sufficient — no overrides needed.
 */
describe('NodesModule (real Nest DI)', () => {
  it('compiles the module graph and resolves ExecuteResearchNode from the container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [NodesModule],
    }).compile();

    try {
      // If ToolsModule fails to export the three tools, .compile() above
      // throws UnknownDependenciesException before we ever reach this line.
      expect(moduleRef.get(ExecuteResearchNode)).toBeDefined();
    } finally {
      await moduleRef.close();
    }
  });
});
