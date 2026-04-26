import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Module path resolution that works in both ESM bundle (production) and CJS
// test runtime. See `self-updater.ts` for the same pattern. The literal
// `import.meta.url` lives only inside a `new Function(...)` body so the CJS
// transpiler doesn't choke on it.
let resolvedDir: string;
try {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const importMetaUrl = new Function('return import.meta.url')() as string;
  resolvedDir = dirname(fileURLToPath(importMetaUrl));
} catch {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cjsDirname: string = (globalThis as any).__dirname ?? '';
  resolvedDir = cjsDirname;
}
const moduleDir = resolvedDir;

let cached: string | null = null;

export function getNodeVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(
      readFileSync(join(moduleDir, '..', '..', 'package.json'), 'utf-8'),
    );
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached!;
}
