/**
 * Side-effect setup for config-selfheal.spec.ts.
 *
 * Sets SYNAPSEIA_HOME to a unique per-process temp dir and MUST be
 * imported BEFORE `../modules/config/config`. ES module imports are
 * hoisted and evaluated in source order, so the named `config` import
 * captures `CONFIG_DIR` from `process.env.SYNAPSEIA_HOME` at evaluation
 * time. A top-level assignment inside the spec runs AFTER the hoisted
 * import and is therefore too late — the env must be set from a module
 * that is imported first. Without this, `CONFIG_DIR` falls back to the
 * real `~/.synapseia`, and the tests would read/write the operator's
 * live config.
 */
import { tmpdir } from 'os';
import { join } from 'path';

export const SELFHEAL_HOME = join(
  tmpdir(),
  `synapseia-selfheal-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

process.env.SYNAPSEIA_HOME = SELFHEAL_HOME;
