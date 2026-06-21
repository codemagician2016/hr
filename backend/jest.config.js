// Jest config for the backend. Kept minimal on purpose — tests live in
// backend/test/ and anything else is opt-in as we need it.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  // Don't crawl node_modules. Don't run Prisma's generated client.
  modulePathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/prisma/'],
  // Kill hanging tests after 10s. Unit tests should be near-instant.
  testTimeout: 10000,
  // No coverage gate yet — we're bootstrapping the suite, not enforcing
  // thresholds. Revisit when we have >50 tests.
  collectCoverage: false,
  // ioredis uses native bindings not available in test environment
  moduleNameMapper: {
    '^ioredis$': '<rootDir>/test/__mocks__/ioredis.js',
  },
};
