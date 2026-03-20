import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['esm'],
  outExtension: () => ({ js: '.js' }),
  target: 'es2022', // ES2022 has native decorator support
  clean: true,
  // Force SWC for decorator metadata support
  minify: true,
  swcMinify: true,
});
