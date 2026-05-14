import { defineConfig, type Options } from 'tsup';
import { copyFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Single-bundle build for `@synapseia-network/node`.
 *
 * Goal: collapse every JS dep into one `dist/index.js` so the Tauri
 * DMG can ship the CLI without pulling in 350MB of `node_modules`.
 * Only TRUE native deps (`usearch`) stay external — their `.node`
 * binaries cannot be inlined and must be `require()`'d at runtime
 * from a sibling `node_modules/`.
 *
 * Two builds (the array form gives each entry its own tsup config):
 *
 *   - `index.ts`     — Single bundled module. Inlines the entire CLI
 *     graph + every JS dep into `dist/index.js` (~10-20MB).
 *
 *   - `bootstrap.ts` — `bin.syn` entry. Stays a TINY launcher: zero
 *     static imports, just stderr-patching followed by a dynamic
 *     `import('./index.js')`. Crucially, we build it with
 *     `bundle: false` so tsup leaves the dynamic import alone (a
 *     single bundle config would otherwise follow that import and
 *     inline `index.js` INTO bootstrap.js too, doubling output to
 *     30MB).
 *
 * Native dep handling:
 *   - `usearch` loads a `.node` binary via `dlopen`. The CLI's
 *     `KgShardHnswSearcher` does `createRequire(__filename)('usearch')`
 *     at runtime; we ship `node_modules/usearch/` alongside the
 *     bundle so the resolution succeeds.
 *
 * NestJS optional peer-deps (`class-validator`, `class-transformer`,
 * `@nestjs/microservices`, `@nestjs/platform-express`,
 * `@nestjs/websockets`) are guarded inside NestJS by `loadPackage()`
 * try/catch. We're a CLI, not an HTTP/RPC/WS server, so they're
 * never reached at runtime. Externalizing keeps esbuild from
 * crashing on the unresolved `require()`s.
 */

// Native + NestJS-optional externals. Wired via an esbuild
// onResolve plugin (not tsup's `external` field) because
// `noExternal: [/.*/]` overrides the latter.
const EXTERNAL_PACKAGES = new Set([
  'usearch',
  'class-validator',
  'class-transformer',
  '@nestjs/microservices',
  '@nestjs/microservices/microservices-module',
  '@nestjs/platform-express',
  '@nestjs/websockets',
  '@nestjs/websockets/socket-module',
]);

const externalsPlugin: NonNullable<Options['esbuildPlugins']>[number] = {
  name: 'syn-externals',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (EXTERNAL_PACKAGES.has(args.path)) {
        return { path: args.path, external: true };
      }
      return null;
    });
  },
};

// Banner injected into every chunk so `__filename` / `__dirname`
// resolve to the chunk's own location at runtime. tsup's
// `shims: true` doesn't work for us — it bundles a single shim
// file whose `import.meta.url` points back at the shim itself.
// The banner inlines the resolution into every chunk's top, so
// each chunk's `__dirname` is genuinely "where this code lives".
//
// Also exposes a CJS-compatible `require` shim so transitive deps
// that call `require('foo')` at runtime once bundled (e.g.
// langchain optional loaders) don't throw "require is not
// defined in ES module scope".
const ESM_BANNER =
  'import { fileURLToPath as __synFup } from "url";' +
  'import { dirname as __synDn } from "path";' +
  'import { createRequire as __synCr } from "module";' +
  'const __filename = __synFup(import.meta.url);' +
  'const __dirname = __synDn(__filename);' +
  'const require = __synCr(import.meta.url);';

const sharedOptions = {
  format: ['esm'] as const,
  outExtension: () => ({ js: '.js' }),
  target: 'node20',
  platform: 'node' as const,
  banner: { js: ESM_BANNER },
  // Minification breaks design:paramtypes (NestJS DI) and yields
  // useless stack traces on user-reported errors. Keep off.
  minify: false,
  swcMinify: false,
  // Sourcemaps so support requests can map back to TS source.
  sourcemap: true,
};

export default defineConfig([
  // Build #1: the single bundled CLI module.
  {
    ...sharedOptions,
    entry: ['src/cli/index.ts'],
    clean: true,
    bundle: true,
    splitting: false,
    treeshake: true,
    // Force tsup to inline EVERY dep. Without this, tsup treats
    // anything listed under `dependencies` as external (library-
    // mode default), which produced an 800KB output with hundreds
    // of top-level `import 'pkg'` statements still referencing
    // node_modules at runtime — defeating the whole point of this
    // bundle. The regex matches every package; the esbuild plugin
    // subtracts the truly-unresolvable ones.
    noExternal: [/.*/],
    esbuildPlugins: [externalsPlugin],
    // Copy Python scripts next to dist output so train_micro.py is
    // always findable via the `__dirname`-walking logic in
    // trainer.ts.
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
  },
  // Build #2: bootstrap launcher + its sibling helper. Stays tiny.
  // `bundle: false` makes tsup transpile only — the dynamic
  // `import('./index.js')` in bootstrap.ts is left untouched and
  // resolves against the sibling bundled module at runtime. The
  // `bigint-warning-filter.ts` helper is shipped as its own
  // `dist/bigint-warning-filter.js` so bootstrap can statically import
  // it without dragging the full CLI bundle along (defeats the whole
  // point of keeping bootstrap tiny).
  // `clean: false` so we don't wipe build #1's output.
  {
    ...sharedOptions,
    entry: ['src/cli/bootstrap.ts', 'src/cli/bigint-warning-filter.ts'],
    clean: false,
    bundle: false,
  },
]);
