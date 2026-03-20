import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  target: 'node20',
  clean: true,
  shims: true,
});
