import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['esm'],
  outExtension: () => ({ js: '.js' }),
  target: 'es2022', // ES2022 has native decorator support
  clean: true,
  // Minification can break design:paramtypes — keep off
  minify: false,
  swcMinify: false,
  // Copy Python scripts next to dist output so train_micro.py is always findable
  async onSuccess() {
    try {
      const srcDir = join(process.cwd(), 'scripts');
      const dstDir = join(process.cwd(), 'dist', 'scripts');
      mkdirSync(dstDir, { recursive: true });
      for (const f of readdirSync(srcDir)) {
        copyFileSync(join(srcDir, f), join(dstDir, f));
      }
      console.log('[tsup] Copied scripts/ → dist/scripts/');
    } catch (e) {
      console.warn('[tsup] Could not copy scripts:', (e as Error).message);
    }
  },
});
