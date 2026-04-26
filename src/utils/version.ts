import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// ESM bundle: __dirname is not defined. Resolve it from import.meta.url.
const __dirname = dirname(fileURLToPath(import.meta.url));

let cached: string | null = null;

export function getNodeVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'),
    );
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached!;
}
