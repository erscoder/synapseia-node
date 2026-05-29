/**
 * Stryker — mutation testing for node (Synapseia agent CLI).
 *
 * ESM + ts-jest setup differs from the coordinator: Jest needs
 * `--experimental-vm-modules` and Stryker's sandbox must preserve
 * `src/__mocks__/**` so libp2p / @noble mocks resolve.
 *
 * Run: `npm run test:mutation`
 */
// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'jest',
  testRunnerNodeArgs: ['--experimental-vm-modules'],
  plugins: ['@stryker-mutator/jest-runner'],
  coverageAnalysis: 'off',
  timeoutMS: 45_000,
  timeoutFactor: 2,
  concurrency: 2,
  checkers: [],
  // Many legacy tests reference top-level `jest.*` globals or `require()`
  // in a way that fails under Stryker's ESM sandbox (Jest 29 + Node 24 +
  // experimental-vm-modules). We narrow Stryker to the spec files that
  // actually exercise the mutated surface — one file per mutate[] entry —
  // keeping the sandbox green without touching existing test code.
  jest: {
    config: {
      testMatch: [
        '<rootDir>/src/utils/__tests__/node-auth.spec.ts',
        '<rootDir>/src/modules/inference/__tests__/bid-responder.spec.ts',
        '<rootDir>/src/modules/inference/__tests__/inference-server.spec.ts',
        '<rootDir>/src/modules/model/__tests__/active-model-subscriber.spec.ts',
        '<rootDir>/src/modules/llm/__tests__/llm-provider.spec.ts',
        // Signature-verification / reward-sensitive surface. Each spec below
        // uses REAL crypto (native `crypto.sign`/`verify`, `bs58.decode`,
        // SHA-256 Merkle) — no @noble/@libp2p mocks on the mutated path — so
        // mutants in the corresponding source are actually killed.
        '<rootDir>/src/modules/a2a/__tests__/auth.spec.ts',
        '<rootDir>/src/p2p/topics/__tests__/work-order-available.spec.ts',
        '<rootDir>/src/p2p/protocols/__tests__/coordinator-pubkey.spec.ts',
        '<rootDir>/src/modules/crypto/__tests__/merkle-tree.spec.ts',
        '<rootDir>/src/modules/agent/__tests__/commit-reveal-v2.spec.ts',
      ],
    },
  },
  mutate: [
    'src/utils/node-auth.ts',
    'src/modules/inference/bid-responder.ts',
    'src/modules/inference/inference-server.ts',
    'src/modules/model/active-model-subscriber.ts',
    'src/modules/llm/llm-provider.ts',
    // Signature-verification / reward-sensitive files. Each is exercised by a
    // real-crypto spec listed in jest.config.testMatch above:
    //  - verify-ed25519.ts        → work-order-available.spec / node-auth.spec
    //                               / auth.spec (all sign+verify with native crypto)
    //  - work-order-available.ts  → work-order-available.spec (real Ed25519)
    //  - a2a-auth.service.ts      → auth.spec (real Ed25519 keypairs + signing)
    //  - coordinator-pubkey.ts    → coordinator-pubkey.spec (real bs58 golden vectors)
    //  - merkle-tree.ts           → merkle-tree.spec (real SHA-256 known vectors)
    //  - commit-reveal-v2.ts      → commit-reveal-v2.spec (real SHA-256 commit/reveal)
    'src/p2p/protocols/verify-ed25519.ts',
    'src/p2p/topics/work-order-available.ts',
    'src/modules/a2a/auth/a2a-auth.service.ts',
    'src/p2p/protocols/coordinator-pubkey.ts',
    'src/modules/crypto/merkle-tree.ts',
    'src/modules/agent/commit-reveal-v2.ts',
  ],
  reporters: ['clear-text', 'html', 'progress'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  thresholds: { high: 80, low: 60, break: null },
  logLevel: 'info',
  ignorePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/reports/**',
  ],
};

export default config;
