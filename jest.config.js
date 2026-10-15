module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // test/server runs the real bundle against DynamoDB Local: `npm run test:int`.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/server/'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testTimeout: 120000,
};
