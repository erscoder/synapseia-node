export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^libp2p$': '<rootDir>/src/__mocks__/libp2p.ts',
    '^@libp2p/(.*)$': '<rootDir>/src/__mocks__/@libp2p/$1.ts',
    '^@noble/ed25519$': '<rootDir>/src/__mocks__/@noble/ed25519.ts',
    '^@noble/hashes$': '<rootDir>/src/__mocks__/@noble/hashes.ts',
    '^@noble/hashes/sha2$': '<rootDir>/src/__mocks__/@noble/hashes.ts',
    // Subpath imports added in @noble/hashes v2 (sha2.js, etc.) — same mock
    '^@noble/hashes/sha2\\.js$': '<rootDir>/src/__mocks__/@noble/hashes.ts',
    '^@noble/hashes/(.+)\\.js$': '<rootDir>/src/__mocks__/@noble/hashes.ts',
    // @solana/web3.js imports `@noble/hashes/utils` (no .js suffix) and the
    // mock must intercept that too — otherwise utils_ts_1.utf8ToBytes is undefined.
    '^@noble/hashes/(.+)$': '<rootDir>/src/__mocks__/@noble/hashes.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: './tsconfig.test.json',
        diagnostics: false,
      },
    ],
  },
  testEnvironment: 'node',
  forceExit: true,
  testTimeout: 15000,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
  ],
  coveragePathIgnorePatterns: [
    '/src/cli/',
    '/src/index.ts',
    '/src/wallet.ts',
    '/src/solana-balance.ts',
  ],
  coverageDirectory: 'coverage',
  maxWorkers: 4,
};
