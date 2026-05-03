import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

export default defineConfig({
  // `bootstrap.ts` is the `bin.syn` entry — it patches stderr before
  // dynamic-importing `index.js`. Both need to be built side-by-side.
  entry: ['src/cli/index.ts', 'src/cli/bootstrap.ts'],
  format: ['esm'],
  outExtension: () => ({ js: '.js' }),
  target: 'es2022', // ES2022 has native decorator support
  clean: true,
  // Keep `usearch` outside the bundle — it ships prebuilt N-API binaries
  // for darwin-arm64 / linux-x64 / linux-arm64 that tsup can't introspect
  // (they're loaded via dlopen at runtime). Bundling it produced a
  // `Dynamic require of "usearch" is not supported` ESM crash inside
  // KgShardHnswSearcher's `require('usearch')` factory; with `external`
  // set, the require call survives in the output and the runtime
  // `createRequire(import.meta.url)` shim resolves it from node_modules.
  external: ['usearch'],
  // Minification can break design:paramtypes — keep off
  minify: false,
  swcMinify: false,
  // Inject __filename / __dirname per-chunk so they resolve to the chunk's
  // own location at runtime. tsup's `shims: true` doesn't work for our
  // case — it bundles a single shim file whose `import.meta.url` points
  // back at the shim itself, so consumers reading `__dirname` get the
  // shim's directory instead of the chunk that imported it. The banner
  // approach inlines the resolution into every chunk's top, so each
  // chunk's `__dirname` is genuinely "where this code lives".
  banner: {
    js:
      'import { fileURLToPath as __synFup } from "url";' +
      'import { dirname as __synDn } from "path";' +
      'const __filename = __synFup(import.meta.url);' +
      'const __dirname = __synDn(__filename);',
  },
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
