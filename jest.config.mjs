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
