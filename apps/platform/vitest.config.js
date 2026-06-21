// Vitest config for the storefront frontend (business/).
//
// We test pure ES modules (libs under business/lib/) against the node
// runtime — no jsdom yet because nothing here actually depends on DOM
// APIs. Add `environment: 'happy-dom'` and the @testing-library packages
// when component tests start landing.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.{js,jsx}', 'lib/**/*.test.{js,jsx}'],
    // Don't crawl node_modules. Don't pick up Next.js generated files.
    exclude: ['node_modules', '.next', 'dist'],
    // Same 10s ceiling as the backend's Jest. Frontend unit tests should
    // be near-instant; anything slower is probably not a unit test.
    testTimeout: 10000,
  },
  resolve: {
    // Mirrors the @/lib/* alias used in the Next.js app so tests can
    // import the same way components do.
    alias: {
      '@': new URL('./', import.meta.url).pathname,
    },
  },
});
