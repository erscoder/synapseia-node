/**
 * install-deps — LoRA stack version-gate spec.
 *
 * Pure-function spec for `loraStackNeedsReinstall` + the pinned pip args.
 *
 * Root cause covered: the LoRA stack used to install `transformers>=4.43`
 * with NO upper bound, so pip pulled transformers 5.x (5.9.0), which
 * REMOVED the `tokenizer=` kwarg on `Trainer.__init__` (→ `processing_class`).
 * `train_lora.py` passes `Trainer(..., tokenizer=tokenizer, ...)`, so every
 * LoRA run on those nodes died with
 *   `TypeError: Trainer.__init__() got an unexpected keyword argument 'tokenizer'`.
 *
 * Two-part fix:
 *   1. Pin to `transformers>=4.43,<5` (asserted on LORA_STACK_PIP_ARGS).
 *   2. The "already installed" probe must enforce `< 5`, not just presence,
 *      so the live pods already on 5.9.0 are DOWNGRADED on update instead
 *      of skipped. `loraStackNeedsReinstall` is that decision, isolated as
 *      a pure function and tested here (no subprocess), mirroring the
 *      `selectTorchSpec` / `pickTorchWheel` spec pattern.
 */

import { describe, it, expect } from '@jest/globals';
import {
  loraStackNeedsReinstall,
  LORA_STACK_PIP_ARGS,
  LORA_STACK_MANUAL_SPEC,
} from '../install-deps';

describe('install-deps LORA_STACK_PIP_ARGS (transformers<5 pin)', () => {
  it('pins transformers with an upper bound of <5', () => {
    expect(LORA_STACK_PIP_ARGS).toContain('transformers>=4.43,<5');
    // The old unbounded spec must NOT survive anywhere in the args.
    expect(LORA_STACK_PIP_ARGS).not.toContain('transformers>=4.43');
  });

  it('keeps the rest of the stack unpinned (peft 0.19.1 etc. work with 4.57)', () => {
    expect(LORA_STACK_PIP_ARGS).toEqual([
      'install',
      'transformers>=4.43,<5',
      'peft',
      'datasets',
      'safetensors',
      'accelerate',
    ]);
  });

  it('manual hint spec mirrors the pinned transformers ceiling', () => {
    expect(LORA_STACK_MANUAL_SPEC).toContain('transformers>=4.43,<5');
  });
});

describe('install-deps loraStackNeedsReinstall (version gate)', () => {
  it('absent stack (no version captured) → (re)install', () => {
    // Probe import failed → undefined version → must install.
    expect(loraStackNeedsReinstall(undefined)).toBe(true);
  });

  it('installed transformers 5.9.0 (live pods) → force reinstall/downgrade', () => {
    // The exact version on the live A5000 pods that breaks Trainer(tokenizer=...).
    expect(loraStackNeedsReinstall('5.9.0')).toBe(true);
  });

  it('installed transformers 5.0.0 (major 5 boundary) → force reinstall', () => {
    expect(loraStackNeedsReinstall('5.0.0')).toBe(true);
  });

  it('installed transformers 6.x (future major) → force reinstall', () => {
    expect(loraStackNeedsReinstall('6.1.2')).toBe(true);
  });

  it('installed transformers 4.57.6 (in range) → skip', () => {
    // What `transformers>=4.43,<5` resolves to today; Trainer(tokenizer=...) works.
    expect(loraStackNeedsReinstall('4.57.6')).toBe(false);
  });

  it('installed transformers 4.43.0 (floor) → skip', () => {
    expect(loraStackNeedsReinstall('4.43.0')).toBe(false);
  });

  it('unparseable version string → fail-closed to reinstall', () => {
    expect(loraStackNeedsReinstall('not-a-version')).toBe(true);
    expect(loraStackNeedsReinstall('')).toBe(true);
  });

  it('whitespace-padded version is trimmed before parsing', () => {
    expect(loraStackNeedsReinstall('  5.9.0  ')).toBe(true);
    expect(loraStackNeedsReinstall('  4.57.6  ')).toBe(false);
  });
});
