export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^libp2p$': '<rootDir>/src/__mocks__/libp2p.ts',
    '^@libp2p/(.*)$': '<rootDir>/src/__mocks__/@libp2p/$1.ts',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          strict: false,
          strictNullChecks: false,
        },
      },
    ],
  },
  testEnvironment: 'node',
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
