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
      ],
    },
  },
  mutate: [
    'src/utils/node-auth.ts',
    'src/modules/inference/bid-responder.ts',
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
