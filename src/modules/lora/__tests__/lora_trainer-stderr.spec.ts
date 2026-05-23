// Bug (live, both A5000 pods, 2026-05-23): transformers 4.57.6 removed
// `Trainer(tokenizer=...)`. The Python trainer prints the real exception
// (`TypeError: ... unexpected keyword argument 'tokenizer'`) at the END of
// stderr, after pages of torch/transformers import noise. The TS layer sliced
// stderr HEAD-only (slice(0, 800)), burying the real error. `tailStderr` now
// keeps a small head + a larger tail so the actual exception surfaces.

import { tailStderr } from '../lora_trainer';

describe('tailStderr — surfaces the real Python exception at the tail', () => {
  it('returns short stderr unchanged (trimmed)', () => {
    const s = 'error: boom\n';
    expect(tailStderr(s)).toBe('error: boom');
  });

  it('keeps the tail when stderr is longer than head+tail budget', () => {
    const noise = 'x'.repeat(5000);
    const realError = "error: Trainer.__init__() got an unexpected keyword argument 'tokenizer'";
    const out = tailStderr(noise + '\n' + realError);
    // The real exception (at the very end) must be present.
    expect(out).toContain(realError);
    // And the output must be bounded (not the whole 5KB+ blob).
    expect(out.length).toBeLessThan(noise.length);
    expect(out).toContain('[truncated]');
  });

  it('keeps a head slice so missing-dep context is still visible', () => {
    const head = "Traceback (most recent call last):";
    const out = tailStderr(head + 'y'.repeat(5000) + '\nerror: late failure');
    expect(out.startsWith(head)).toBe(true);
    expect(out).toContain('error: late failure');
  });

  it('respects custom head/tail budgets', () => {
    const body = 'a'.repeat(100) + 'TAIL_MARKER';
    const out = tailStderr(body, 10, 20);
    expect(out).toContain('TAIL_MARKER');
    expect(out).toContain('[truncated]');
    // head(10) + marker + truncation marker ⇒ far smaller than the 111-char body.
    expect(out.length).toBeLessThan(body.length);
  });
});
