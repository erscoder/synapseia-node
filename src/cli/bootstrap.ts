#!/usr/bin/env node
/**
 * CLI bootstrap — runs BEFORE the real CLI bundle is loaded.
 *
 * Why this extra file exists:
 *   ES module `import` statements are hoisted and execute at parse time —
 *   even when my stderr-filter function is written at the top of
 *   `src/cli/index.ts`, the bundler's transitive imports (including
 *   `bigint-buffer` somewhere deep in the Solana tree) fire their
 *   module-level `console.warn(...)` BEFORE any statement in the entry
 *   file has a chance to run.
 *
 * Fix: make this file the CLI entry (`bin.syn` in package.json). It has
 *   zero static imports, so its top-level statements run first. It
 *   patches stderr, then dynamically imports the real CLI. Any
 *   `bigint: Failed to load bindings` warnings emitted by the subsequent
 *   module graph are caught by the already-registered filter.
 */

// Mute the single `bigint: Failed to load bindings, pure JS will be used`
// line from `bigint-buffer`. The pure-JS fallback works correctly — the
// message only adds noise above the wallet password prompt. Every other
// stderr write passes through untouched.
(function muteBigintBindingWarning() {
  const originalWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stderr.write = function patched(chunk: any, ...rest: any[]): boolean {
    const s = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? '';
    if (s.includes('bigint: Failed to load bindings, pure JS will be used')) {
      return true;
    }
    return (originalWrite as any)(chunk, ...rest);
  } as typeof process.stderr.write;
})();

// Hand off to the real CLI. Dynamic import so the filter above is
// registered before the bundle's imports start executing. Promise-style
// (no top-level await) so tsc --noEmit is happy under the repo's current
// ES2020 target — tsup transpiles to ES2022 for the actual bundle.
import('./index.js').catch((err) => {
  // Write directly to the original stderr (bypass our filter) so any real
  // bootstrap failure surfaces loud and clear.
  process.stderr.write(`[bootstrap] Failed to load CLI: ${(err as Error).message}\n`);
  process.exit(1);
});

// `export {}` marks this as an ES module so Node treats the shebang'd file
// correctly and the build target isn't a plain script.
export {};
