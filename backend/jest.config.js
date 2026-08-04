// Jest config for the backend. Kept minimal on purpose — tests live in
// backend/test/ and anything else is opt-in as we need it.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  // This repo runs TWO kinds of test: jest suites (describe/it) and plain-node
  // suites executed directly with `node <file>` — the live-DB integration and
  // e2e ones, which need a real hr_test schema and print their own PASS/FAIL.
  // Jest matches them by filename and then fails them with "Your test suite must
  // contain at least one test", which is a false red: the suites are fine, jest
  // simply is not their runner. Eight suites failed this way and buried the real
  // signal. Run them with `bash qa/run-all-tests.sh` (or node directly) instead.
  //
  // Note this list must live HERE and not on the CLI: passing
  // --testPathIgnorePatterns REPLACES this array rather than adding to it, so
  // the old `jest --testPathIgnorePatterns=auth-cookie-isolation` in the npm
  // script silently discarded everything below. The script is now plain `jest`.
  testPathIgnorePatterns: [
    '<rootDir>/test/e2e/',                       // plain-node integration suites
    '<rootDir>/test/boot.test.js',               // require-graph smoke, run via npm run test:boot
    '<rootDir>/test/countryContextRouteScope.test.js',
    '<rootDir>/test/auth-cookie-isolation.test.js', // node:test runner, see test:auth-cookies
  ],
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
