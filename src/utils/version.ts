import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

// Walk up from this file's directory until we find the synapseia node
// package.json. Robust across dev (src/utils/), production bundle (dist/),
// and any chunk-split tsup layout. `__dirname` is provided by the tsup
// banner shim in ESM and natively by Node in CJS jest.

let cached: string | null = null;

export function getNodeVersion(): string {
  if (cached) return cached;
  try {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string; version?: string };
        if (pkg.name && pkg.name.includes('synapseia') && pkg.version) {
          cached = pkg.version;
          return cached;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    cached = '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached!;
}
