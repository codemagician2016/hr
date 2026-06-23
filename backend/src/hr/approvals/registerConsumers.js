'use strict';

/**
 * registerConsumers.js — Feature 10 slice 10c boot wiring. Required ONCE from the HR
 * bootstrap (hr/routes/index.js) so `consumers.get('LEAVE'|'EXPENSE')` resolves at
 * the moment the engine fires a callback.
 *
 * Registration is idempotent + side-effect-free at module load (it only populates an
 * in-memory Map keyed by WorkflowModule), so requiring this module repeatedly is
 * harmless. A module without a registered consumer still routes through the engine;
 * its callbacks are simply no-ops (the registry's `fire` swallows "not registered").
 */

const { registerLeaveConsumer } = require('./consumers.leave');
const { registerExpenseConsumer } = require('./consumers.expense');

let done = false;

function registerConsumers() {
  if (done) return;
  registerLeaveConsumer();
  registerExpenseConsumer();
  done = true;
}

// Register on first require so the boot graph wires the consumers as a side effect of
// loading the HR API (see hr/routes/index.js). Also exported for explicit calls/tests.
registerConsumers();

module.exports = { registerConsumers };
