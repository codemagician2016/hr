'use strict';
// Boot smoke test: requiring index.js must resolve the ENTIRE route/controller/
// middleware require-graph (this catches dangling requires to deleted modules,
// e.g. the removed chat product) WITHOUT binding a port — index.js only calls
// app.listen when run directly (require.main === module). Run: node test/boot.test.js
const assert = require('assert');

const app = require('../src/index.js');
assert.strictEqual(typeof app, 'function', 'index.js must export the Express app');
assert.strictEqual(typeof app.listen, 'function', 'the export must be an Express app instance');

console.log('boot smoke PASS: index.js require-graph resolves; Express app exported.');
