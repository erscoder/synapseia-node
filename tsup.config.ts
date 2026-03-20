import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['esm'],
  outExtension: () => ({ js: '.js' }),
  target: 'node20',
  clean: true,
});
